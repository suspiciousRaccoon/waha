import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AppsService,
  IAppsService,
} from '@waha/apps/app_sdk/services/IAppsService';
import { EngineBootstrap } from '@waha/core/abc/EngineBootstrap';
import { GowsEngineConfigService } from '@waha/core/config/GowsEngineConfigService';
import { WebJSEngineConfigService } from '@waha/core/config/WebJSEngineConfigService';
import { WhatsappSessionGoWSCore } from '@waha/core/engines/gows/session.gows.core';
import { WebhookConductor } from '@waha/core/integrations/webhooks/WebhookConductor';
import { MediaStorageFactory } from '@waha/core/media/MediaStorageFactory';
import { DefaultMap } from '@waha/utils/DefaultMap';
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { promiseTimeout, sleep } from '@waha/utils/promiseTimeout';
import { complete } from '@waha/utils/reactive/complete';
import { SwitchObservable } from '@waha/utils/reactive/SwitchObservable';
import { PinoLogger } from 'nestjs-pino';
import { Observable, retry, share } from 'rxjs';
import { map } from 'rxjs/operators';

import { WhatsappConfigService } from '../config.service';
import {
  WAHAEngine,
  WAHAEvents,
  WAHASessionStatus,
} from '../structures/enums.dto';
import {
  ProxyConfig,
  SessionConfig,
  SessionDetailedInfo,
  SessionDTO,
  SessionInfo,
} from '../structures/sessions.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';
import { populateSessionInfo, SessionManager } from './abc/manager.abc';
import { SessionParams, WhatsappSession } from './abc/session.abc';
import { EngineConfigService } from './config/EngineConfigService';
import { WhatsappSessionNoWebCore } from './engines/noweb/session.noweb.core';
import { WhatsappSessionWebJSCore } from './engines/webjs/session.webjs.core';
import { DOCS_URL } from './exceptions';
import { getProxyConfig } from './helpers.proxy';
import { MediaManager } from './media/MediaManager';
import { LocalSessionAuthRepository } from './storage/LocalSessionAuthRepository';
import { LocalSessionConfigRepository } from './storage/LocalSessionConfigRepository';
import { LocalStoreCore } from './storage/LocalStoreCore';

enum SessionState {
  STOPPED = 'STOPPED',
  RUNNING = 'RUNNING',
}

interface SessionEntry {
  session: WhatsappSession;
  config: SessionConfig;
  state: SessionState;
}

@Injectable()
export class SessionManagerCore extends SessionManager implements OnModuleInit {
  SESSION_STOP_TIMEOUT = 3000;

  // Map of session name to session instance and config
  private sessions: Map<string, SessionEntry> = new Map();

  protected readonly EngineClass: typeof WhatsappSession;
  protected events2: DefaultMap<string, DefaultMap<WAHAEvents, SwitchObservable<any>>>;
  protected readonly engineBootstrap: EngineBootstrap;

  constructor(
    config: WhatsappConfigService,
    private engineConfigService: EngineConfigService,
    private webjsEngineConfigService: WebJSEngineConfigService,
    gowsConfigService: GowsEngineConfigService,
    log: PinoLogger,
    private mediaStorageFactory: MediaStorageFactory,
    @Inject(AppsService)
    appsService: IAppsService,
  ) {
    super(log, config, gowsConfigService, appsService);
    const engineName = this.engineConfigService.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.engineBootstrap = this.getEngineBootstrap(engineName);

    // Nested map: sessionName -> eventType -> observable
    this.events2 = new DefaultMap<string, DefaultMap<WAHAEvents, SwitchObservable<any>>>(
      (sessionName) =>
        new DefaultMap<WAHAEvents, SwitchObservable<any>>(
          (event) =>
            new SwitchObservable((obs$) => {
              return obs$.pipe(retry(), share());
            }),
        ),
    );

    this.store = new LocalStoreCore(engineName.toLowerCase());
    this.sessionAuthRepository = new LocalSessionAuthRepository(this.store);
    this.sessionConfigRepository = new LocalSessionConfigRepository(this.store);
    this.clearStorage().catch((error) => {
      this.log.error({ error }, 'Error while clearing storage');
    });
  }

  protected getEngine(engine: WAHAEngine): typeof WhatsappSession {
    if (engine === WAHAEngine.WEBJS) {
      return WhatsappSessionWebJSCore;
    } else if (engine === WAHAEngine.NOWEB) {
      return WhatsappSessionNoWebCore;
    } else if (engine === WAHAEngine.GOWS) {
      return WhatsappSessionGoWSCore;
    } else {
      throw new NotFoundException(`Unknown whatsapp engine '${engine}'.`);
    }
  }

  async beforeApplicationShutdown(signal?: string) {
    // Stop all running sessions
    const sessionNames = Array.from(this.sessions.keys());
    for (const name of sessionNames) {
      const entry = this.sessions.get(name);
      if (entry?.state === SessionState.RUNNING) {
        await this.stop(name, true);
      }
    }
    this.stopEvents();
    await this.engineBootstrap.shutdown();
  }

  async onApplicationBootstrap() {
    await this.engineBootstrap.bootstrap();
    this.startPredefinedSessions();
  }

  private async clearStorage() {
    const storage = await this.mediaStorageFactory.build(
      'all',
      this.log.logger.child({ name: 'Storage' }),
    );
    await storage.purge();
  }

  //
  // API Methods
  //
  async exists(name: string): Promise<boolean> {
    // Check in-memory first
    if (this.sessions.has(name)) {
      return true;
    }
    // Check disk for existing session
    return await this.sessionConfigRepository.exists(name);
  }

  isRunning(name: string): boolean {
    const entry = this.sessions.get(name);
    return entry?.state === SessionState.RUNNING;
  }

  async upsert(name: string, config?: SessionConfig): Promise<void> {
    const entry = this.sessions.get(name);
    
    // Load config from disk if it exists and no config provided
    let sessionConfig = config;
    if (!sessionConfig && !entry) {
      const diskConfig = await this.sessionConfigRepository.getConfig(name);
      if (diskConfig) {
        sessionConfig = diskConfig;
      }
    }
    
    if (entry) {
      // Update existing session config
      entry.config = sessionConfig || entry.config || {};
    } else {
      // Create new stopped session entry
      this.sessions.set(name, {
        session: null,
        config: sessionConfig || {},
        state: SessionState.STOPPED,
      });
    }
    
    // Persist config to disk
    if (sessionConfig !== undefined) {
      await this.sessionConfigRepository.saveConfig(name, sessionConfig);
    }
  }
  async start(name: string): Promise<SessionDTO> {
    let entry = this.sessions.get(name);
    
    // If session doesn't exist in memory, try to load from disk
    if (!entry) {
      const exists = await this.exists(name);
      if (exists) {
        // Load from disk
        await this.upsert(name);
        entry = this.sessions.get(name);
      } else {
        throw new NotFoundException(`Session '${name}' does not exist.`);
      }
    }
    
    if (entry.state === SessionState.RUNNING) {
      throw new UnprocessableEntityException(
        `Session '${name}' is already started.`,
      );
    }

    const sessionConfig = entry?.config || {};
    
    this.log.info({ session: name }, `Starting session...`);
    const logger = this.log.logger.child({ session: name });
    logger.level = getPinoLogLevel(sessionConfig?.debug);
    const loggerBuilder: LoggerBuilder = logger;

    const storage = await this.mediaStorageFactory.build(
      name,
      loggerBuilder.child({ name: 'Storage' }),
    );
    await storage.init();
    const mediaManager = new MediaManager(
      storage,
      this.config.mimetypes,
      loggerBuilder.child({ name: 'MediaManager' }),
    );

    const webhook = new WebhookConductor(loggerBuilder);
    const proxyConfig = this.getProxyConfig(name, sessionConfig);
    const sessionParams: SessionParams = {
      name,
      mediaManager,
      loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: sessionConfig,
      ignore: this.ignoreChatsConfig(sessionConfig),
    };
    
    if (this.EngineClass === WhatsappSessionWebJSCore) {
      sessionParams.engineConfig = this.webjsEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionGoWSCore) {
      sessionParams.engineConfig = this.gowsConfigService.getConfig();
    }
    
    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionParams);
    
    // Update or create session entry

    entry.session = session
    entry.state = SessionState.RUNNING
    entry.config = sessionConfig
    // this.sessions.set(name, {
    //   session,
    //   config: sessionConfig,
    // });
    
    this.updateSession(name, session);

    // Configure webhooks
    const webhooks = this.getWebhooks(sessionConfig);
    webhook.configure(session, webhooks);

    // Apps
    try {
      await this.appsService.beforeSessionStart(session, this.store);
    } catch (e) {
      logger.error(`Apps Error: ${e}`);
      session.status = WAHASessionStatus.FAILED;
    }

    // Start session
    if (session.status !== WAHASessionStatus.FAILED) {
      await session.start();
      logger.info('Session has been started.');
      await this.appsService.afterSessionStart(session, this.store);
    }

    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  private updateSession(name: string, session: WhatsappSession) {
    if (!session) {
      // Clear the session's events just in case
      const sessionEvents = this.events2.get(name);
      if (sessionEvents) {
        complete(sessionEvents);
      }
      return;
    }
    
    const sessionEvents = this.events2.get(name);
    for (const eventName in WAHAEvents) {
      const event = WAHAEvents[eventName];
      const stream$ = session
        .getEventObservable(event)
        .pipe(map(populateSessionInfo(event, session)));
      sessionEvents.get(event).switch(stream$);
    }
  }

  getSessionEvent(session: string, event: WAHAEvents): Observable<any> {
    return this.events2.get(session).get(event);
  }

  async stop(name: string, silent: boolean): Promise<void> {
    const entry = this.sessions.get(name);
    
    if (!entry || entry.state !== SessionState.RUNNING) {
      this.log.debug({ session: name }, `Session is not running.`);
      return;
    }

    this.log.info({ session: name }, `Stopping session...`);
  try {
        if (entry.session) {
          await entry.session.stop();
        }
      } catch (err) {
        this.log.warn(`Error while stopping session '${name}'`);
        if (!silent) {
          throw err;
        }
      }
      
      this.log.info({ session: name }, `Session has been stopped.`);
      
      // Update entry to stopped state
      entry.session = null;
      entry.state = SessionState.STOPPED;
      
      this.updateSession(name, null);
      await sleep(this.SESSION_STOP_TIMEOUT);
  }

  async unpair(name: string) {
    const entry = this.sessions.get(name);
    if (!entry?.session) {
      return;
    }

    this.log.info({ session: name }, 'Unpairing the device from account...');
    await entry.session.unpair().catch((err) => {
      this.log.warn(`Error while unpairing from device: ${err}`);
    });
    await sleep(1000);
  }

  async logout(name: string): Promise<void> {
    await this.sessionAuthRepository.clean(name);
  }

  async delete(name: string): Promise<void> {
    await this.appsService.removeBySession(this, name);
    
    // Clear events for this session
    const sessionEvents = this.events2.get(name);
    if (sessionEvents) {
      complete(sessionEvents);
    }
    this.events2.delete(name);
    
    // Remove session from memory
    this.sessions.delete(name);
    
    // Remove session from disk
    try {
      await this.sessionConfigRepository.deleteConfig(name);
    } catch (error) {
      this.log.warn({ session: name, error }, 'Error while deleting session config from disk');
    }
  }

  /**
   * Combine per session and global webhooks
   */
  private getWebhooks(sessionConfig?: SessionConfig): WebhookConfig[] {
    let webhooks: WebhookConfig[] = [];
    if (sessionConfig?.webhooks) {
      webhooks = webhooks.concat(sessionConfig.webhooks);
    }
    const globalWebhookConfig = this.config.getWebhookConfig();
    if (globalWebhookConfig) {
      webhooks.push(globalWebhookConfig);
    }
    return webhooks;
  }
  
  /**
   * Get either session's or global proxy if defined
   */
  protected getProxyConfig(name: string, sessionConfig?: SessionConfig): ProxyConfig | undefined {
    if (sessionConfig?.proxy) {
      return sessionConfig.proxy;
    }
    
    const sessionsMap: Record<string, WhatsappSession> = {};
    for (const [sessionName, entry] of this.sessions.entries()) {
      if (entry.session && entry.state === SessionState.RUNNING) {
        sessionsMap[sessionName] = entry.session;
      }
    }
    
    return getProxyConfig(this.config, sessionsMap, name);
  }

  getSession(name: string): WhatsappSession {
    const entry = this.sessions.get(name);
    if (!entry?.session || entry.state !== SessionState.RUNNING) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
          `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return entry.session;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    const sessionInfos: SessionInfo[] = [];

    for (const [name, entry] of this.sessions.entries()) {
      if (entry.state === SessionState.RUNNING && entry.session) {
        const me = entry.session.getSessionMeInfo();
        sessionInfos.push({
          name: entry.session.name,
          status: entry.session.status,
          config: entry.session.sessionConfig,
          me: me,
          presence: entry.session.presence,
          timestamps: {
            activity: entry.session.getLastActivityTimestamp(),
          },
        });
      } else if (all && entry.state === SessionState.STOPPED) {
        sessionInfos.push({
          name: name,
          status: WAHASessionStatus.STOPPED,
          config: entry.config,
          me: null,
          presence: null,
          timestamps: {
            activity: null,
          },
        });
      }
    }

    return sessionInfos;
  }

  private async fetchEngineInfo(session: WhatsappSession) {
    let engineInfo = {};
    if (session) {
      try {
        engineInfo = await promiseTimeout(1000, session.getEngineInfo());
      } catch (error) {
        this.log.debug(
          { session: session.name, error: `${error}` },
          'Can not get engine info',
        );
      }
    }
    return {
      engine: session?.engine,
      ...engineInfo,
    };
  }

  async getSessionInfo(name: string): Promise<SessionDetailedInfo | null> {
    const entry = this.sessions.get(name);
    if (!entry) {
      return null;
    }

    const sessions = await this.getSessions(true);
    const session = sessions.find(s => s.name === name);
    if (!session) {
      return null;
    }

    const engine = entry.session ? await this.fetchEngineInfo(entry.session) : { engine: null };
    return {
      ...session,
      engine: engine,
    };
  }

  protected stopEvents() {
    this.events2.forEach((map) => { 
      complete(map)
     })
  }

  async onModuleInit() {
    await this.init();
  }

  async init() {
    await this.store.init();
    const knex = this.store.getWAHADatabase();
    await this.appsService.migrate(knex);
    
    // Discover and load existing sessions from disk
    await this.loadExistingSessions();
  }

  /**
   * Discover and load existing sessions from disk into memory
   */
  private async loadExistingSessions(): Promise<void> {
    try {
      const sessionNames = await this.sessionConfigRepository.getAllConfigs();
      this.log.info(
        { count: sessionNames.length },
        `Discovering existing sessions from disk...`,
      );
      
      for (const sessionName of sessionNames) {
        // Skip if already in memory
        if (this.sessions.has(sessionName)) {
          continue;
        }
        
        // Load config from disk
        const config = await this.sessionConfigRepository.getConfig(sessionName);
        
        // Add to in-memory map as stopped
        this.sessions.set(sessionName, {
          session: null,
          config: config || {},
          state: SessionState.STOPPED,
        });
        
        this.log.debug({ session: sessionName }, 'Loaded existing session from disk');
      }
      
      this.log.info(
        { count: sessionNames.length },
        `Loaded ${sessionNames.length} existing session(s) from disk`,
      );
    } catch (error) {
      this.log.error({ error }, 'Error while loading existing sessions from disk');
    }
  }
}