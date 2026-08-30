import type { PrismaClient } from '@prisma/client';

import type { MaxClient } from '../max/max-client';
import { SUBSCRIBED_UPDATE_TYPES } from '../max/max-types';
import type { UpdateType } from '../max/max-types';
import { moduleLogger } from '../utils/logger';
import type { UpdateDispatcher } from './update-dispatcher';

const log = moduleLogger('polling');

const MARKER_KEY = 'polling.marker';
const LONG_POLL_TIMEOUT_SECONDS = 30;

/**
 * Long polling — development only (§2). Production must use the webhook.
 *
 * Updates go through the same UpdateDispatcher as the webhook, and the marker
 * is persisted in SystemSetting, so a restart behaves identically in both
 * modes instead of replaying the last batch.
 */
export class PollingRunner {
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly max: MaxClient,
    private readonly dispatcher: UpdateDispatcher,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.warn('starting long polling — not for production use');
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const marker = await this.readMarker();
        const response = await this.max.api.getUpdates([...SUBSCRIBED_UPDATE_TYPES] as UpdateType[], {
          timeout: LONG_POLL_TIMEOUT_SECONDS,
          ...(marker === undefined ? {} : { marker }),
        });

        for (const update of response.updates ?? []) {
          await this.dispatcher.handle(update);
        }

        if (typeof response.marker === 'number') {
          await this.writeMarker(response.marker);
        }
      } catch (error) {
        if (!this.running) return;
        log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'polling iteration failed; retrying shortly',
        );
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }

  private async readMarker(): Promise<number | undefined> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: MARKER_KEY } });
    if (!row) return undefined;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private async writeMarker(marker: number): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key: MARKER_KEY },
      create: { key: MARKER_KEY, value: String(marker) },
      update: { value: String(marker) },
    });
  }
}
