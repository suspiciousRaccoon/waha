import { WAHASelf } from '@waha/apps/chatwoot/session/WAHASelf';
import { Locale } from '@waha/apps/chatwoot/i18n/locale';
import { Conversation } from '../client/Conversation';
import { ILogger } from '@waha/apps/app_sdk/ILogger';
import { Queue } from 'bullmq';

export interface CommandContext {
  app: string;
  session: string;
  logger: ILogger;
  l: Locale;
  waha: WAHASelf;
  conversation: Conversation;
  queues: {
    importContacts: Queue;
  };
}
