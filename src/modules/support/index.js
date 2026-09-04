import { defineModule } from '../../shared/module.js';

export {
  MemorySupportTicketRepository,
  MemoryTicketRepository,
  SUPPORT_CATEGORIES,
  SUPPORT_LIMITS,
  SUPPORT_TICKET_STATUS,
  SUPPORT_TICKET_STATUSES,
  createMemorySupportTicketRepository,
  normalizeSupportText,
  supportRequestHash,
  textLength
} from './repository.js';
export {
  SupportService,
  SupportTicketService,
  createSupportService,
  createSupportTicketService
} from './service.js';

export const MODULE = defineModule(
  'support',
  'Development/fake-staging plain-text customer-service tickets, messages, ownership and audit boundary; attachments and external channels are disabled.'
);
