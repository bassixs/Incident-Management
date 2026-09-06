import { Bot } from '@maxhub/max-bot-api';
import type { PrismaClient } from '@prisma/client';

import { ClarificationService } from '../clarifications/clarification.service';
import { AnswerService } from '../answers/answer.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import { ActionGuardService } from '../actions/action-guard.service';
import { BanService } from '../bans/ban.service';
import { CategoryService } from '../categories/category.service';
import { getConfig, type AppConfig } from '../config';
import { DeliveryAlertService } from '../delivery/delivery-alert.service';
import { DeliveryProblemService } from '../delivery/delivery-problem.service';
import { RequesterDeliveryService } from '../delivery/requester-delivery.service';
import { DistributionService } from '../distribution/distribution.service';
import { DistributionQueueService } from '../distribution/distribution-queue.service';
import { IncidentHistoryService } from '../incidents/incident-history.service';
import { IncidentStateService } from '../incidents/incident-state.service';
import { IncidentRepository } from '../incidents/incident.repository';
import { IncidentService } from '../incidents/incident.service';
import { LegalAcceptanceService } from '../legal/legal-acceptance.service';
import { createMaxClient, MaxClient } from '../max/max-client';
import { MaxMessageService } from '../max/max-message.service';
import { createMediaStorage, MediaService } from '../media/media.service';
import type { MediaStorage } from '../media/media-storage.interface';
import { ExcelReportService } from '../reports/excel-report.service';
import { RetentionService } from '../retention/retention.service';
import { ResponsibleGroupService } from '../responsible-groups/responsible-group.service';
import { ReviewService } from '../review/review.service';
import { SectorService } from '../sector/sector.service';
import { OperatorSessionService } from '../sessions/operator-session.service';
import { SlaService } from '../sla/sla.service';
import { UserService } from '../users/user.service';

/**
 * Composition root.
 *
 * Handlers receive this object and do nothing but validate input, call one
 * service and render the reply — all business logic lives in the services
 * wired together here.
 */
export type AppServices = {
  config: AppConfig;
  prisma: PrismaClient;
  bot: Bot;
  max: MaxClient;
  messages: MaxMessageService;
  media: MediaService;
  storage: MediaStorage;
  actionGuard: ActionGuardService;
  audit: AdminAuditService;
  retention: RetentionService;
  legal: LegalAcceptanceService;

  users: UserService;
  categories: CategoryService;
  responsibleGroups: ResponsibleGroupService;
  bans: BanService;
  sessions: OperatorSessionService;

  repository: IncidentRepository;
  history: IncidentHistoryService;
  state: IncidentStateService;
  incidents: IncidentService;

  distribution: DistributionService;
  distributionQueue: DistributionQueueService;
  sector: SectorService;
  review: ReviewService;
  answers: AnswerService;
  clarifications: ClarificationService;
  delivery: RequesterDeliveryService;
  deliveryAlerts: DeliveryAlertService;
  deliveryProblems: DeliveryProblemService;

  sla: SlaService;
  reports: ExcelReportService;
};

/**
 * Seams for tests: the MAX transport and the media storage can be swapped for
 * fakes without touching a single line of business code.
 */
export type ServiceOverrides = {
  messages?: MaxMessageService;
  media?: MediaService;
  storage?: MediaStorage;
};

export function buildServices(prisma: PrismaClient, overrides: ServiceOverrides = {}): AppServices {
  const config = getConfig();

  const bot = new Bot(config.BOT_TOKEN, {
    clientOptions: { baseUrl: config.MAX_API_BASE_URL },
  });
  const max = createMaxClient(bot);
  const storage = overrides.storage ?? createMediaStorage();
  const messages = overrides.messages ?? new MaxMessageService(max, { prisma, storage });
  const media = overrides.media ?? new MediaService(storage, max);
  const actionGuard = new ActionGuardService(prisma);
  const audit = new AdminAuditService(prisma);
  const retention = new RetentionService(prisma, storage);
  const legal = new LegalAcceptanceService(prisma, config);

  const users = new UserService(prisma);
  const categories = new CategoryService(prisma);
  const responsibleGroups = new ResponsibleGroupService(prisma);
  const bans = new BanService(prisma);
  const sessions = new OperatorSessionService(prisma);

  const repository = new IncidentRepository(prisma);
  const history = new IncidentHistoryService(prisma);
  const state = new IncidentStateService();
  const incidents = new IncidentService(prisma, repository, history, users, bans, media);

  const delivery = new RequesterDeliveryService(prisma, repository, history, messages, media);
  const deliveryAlerts = new DeliveryAlertService(prisma, max, config.DELIVERY_ALERT_CHAT_ID);
  const deliveryProblems = new DeliveryProblemService(prisma);
  const sector = new SectorService(
    prisma,
    repository,
    incidents,
    history,
    state,
    responsibleGroups,
    messages,
    media,
  );
  const distribution = new DistributionService(
    prisma,
    repository,
    incidents,
    history,
    state,
    responsibleGroups,
    messages,
    media,
    sector,
    delivery,
  );
  const review = new ReviewService(
    prisma,
    repository,
    incidents,
    history,
    state,
    responsibleGroups,
    messages,
    media,
    sector,
    delivery,
    distribution,
  );
  const answers = new AnswerService(prisma, repository, history, state, media, review, distribution);

  const clarifications = new ClarificationService(prisma, repository, messages, media);
  const distributionQueue = new DistributionQueueService(prisma, messages);
  const sla = new SlaService(prisma, repository, history, messages, sessions);
  const reports = new ExcelReportService(repository);

  return {
    config,
    prisma,
    bot,
    max,
    messages,
    media,
    storage,
    actionGuard,
    audit,
    retention,
    legal,
    users,
    categories,
    responsibleGroups,
    bans,
    sessions,
    repository,
    history,
    state,
    incidents,
    distribution,
    sector,
    distributionQueue,
    review,
    answers,
    clarifications,
    delivery,
    deliveryAlerts,
    deliveryProblems,
    sla,
    reports,
  };
}
