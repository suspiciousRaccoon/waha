import { WAHASelf } from '@waha/apps/chatwoot/session/WAHASelf';
import { Locale } from '@waha/apps/chatwoot/i18n/locale';
import { Conversation } from '../client/Conversation';
import { ILogger } from '@waha/apps/app_sdk/ILogger';

export interface CommandContext {
  logger: ILogger;
  l: Locale;
  session: string;
  waha: WAHASelf;
  conversation: Conversation;
}
