import { Bot } from '@maxhub/max-bot-api';
import type { PrismaClient } from '@prisma/client';

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
import { IncidentHistoryService } from '../incidents/incident-history.service';
import { IncidentStateService } from '../incidents/incident-state.service';
import { IncidentRepository } from '../incidents/incident.repository';
import { IncidentService } from '../incidents/incident.service';
import { createMaxClient, MaxClient } from '../max/max-client';
import { MaxMessageService } from '../max/max-message.service';
import { createMediaStorage, MediaService } from '../media/media.service';
import { ExcelReportService } from '../reports/excel-report.service';
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
  actionGuard: ActionGuardService;
  audit: AdminAuditService;

  users: UserService;
  categories: CategoryService;
  bans: BanService;
  sessions: OperatorSessionService;

  repository: IncidentRepository;
  history: IncidentHistoryService;
  state: IncidentStateService;
  incidents: IncidentService;

  distribution: DistributionService;
  sector: SectorService;
  review: ReviewService;
  answers: AnswerService;
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
};

export function buildServices(prisma: PrismaClient, overrides: ServiceOverrides = {}): AppServices {
  const config = getConfig();

  const bot = new Bot(config.BOT_TOKEN, {
    clientOptions: { baseUrl: config.MAX_API_BASE_URL },
  });
  const max = createMaxClient(bot);
  const storage = createMediaStorage();
  const messages = overrides.messages ?? new MaxMessageService(max, { prisma, storage });
  const media = overrides.media ?? new MediaService(storage, max);
  const actionGuard = new ActionGuardService(prisma);
  const audit = new AdminAuditService(prisma);

  const users = new UserService(prisma);
  const categories = new CategoryService(prisma);
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
    categories,
    messages,
    media,
  );
  const review = new ReviewService(
    prisma,
    repository,
    incidents,
    history,
    state,
    categories,
    messages,
    media,
    sector,
    delivery,
  );
  const answers = new AnswerService(prisma, repository, history, state, media, review, sector);

  const distribution = new DistributionService(
    prisma,
    repository,
    incidents,
    history,
    state,
    categories,
    messages,
    media,
    sector,
    delivery,
  );

  const sla = new SlaService(prisma, repository, history, sector, distribution, sessions);
  const reports = new ExcelReportService(repository);

  return {
    config,
    prisma,
    bot,
    max,
    messages,
    media,
    actionGuard,
    audit,
    users,
    categories,
    bans,
    sessions,
    repository,
    history,
    state,
    incidents,
    distribution,
    sector,
    review,
    answers,
    delivery,
    deliveryAlerts,
    deliveryProblems,
    sla,
    reports,
  };
}
