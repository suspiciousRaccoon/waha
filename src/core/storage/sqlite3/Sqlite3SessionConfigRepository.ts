import { ISessionConfigRepository } from '@waha/core/storage/ISessionConfigRepository';
import { LocalStore } from '@waha/core/storage/LocalStore';
import {
  SQLSessionConfigMigrations,
  SQLSessionConfigSchema,
} from '@waha/core/storage/sql/schemas';
import { Sqlite3KVRepository } from '@waha/core/storage/sqlite3/Sqlite3KVRepository';
import { SessionConfig } from '@waha/structures/sessions.dto';
import { Sqlite3SchemaValidation } from '@waha/core/engines/noweb/store/sqlite3/Sqlite3SchemaValidation';

class SessionConfigEntity {
  id: string;
  data?: SessionConfig;
}

export class Sqlite3SessionConfigRepository
  extends Sqlite3KVRepository<SessionConfigEntity>
  implements ISessionConfigRepository
{
  get schema() {
    return SQLSessionConfigSchema;
  }

  get migrations() {
    return SQLSessionConfigMigrations;
  }

  constructor(store: LocalStore) {
    const knex = store.getWAHADatabase();
    super(knex);
  }

  async saveConfig(sessionName: string, config: SessionConfig): Promise<void> {
    return this.upsertOne({ id: sessionName, data: config });
  }

  async getConfig(sessionName: string): Promise<SessionConfig | null> {
    const data = await this.getById(sessionName);
    return data?.data || null;
  }

  async exists(sessionName: string): Promise<boolean> {
    const data = await this.getById(sessionName);
    return data !== null;
  }

  async deleteConfig(sessionName: string): Promise<void> {
    return this.deleteById(sessionName);
  }

  async getAllConfigs(): Promise<string[]> {
    const all = await this.getAll();
    return all.map((item) => item.id);
  }

  async init(): Promise<void> {
    await super.init();
  }

  protected async validateSchema() {
    const validation = new Sqlite3SchemaValidation(this.schema, this.knex);
    await validation.validate();
  }
}
