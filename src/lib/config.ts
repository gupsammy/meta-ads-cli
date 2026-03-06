import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CliConfig {
  auth?: {
    access_token?: string;
    app_id?: string;
    app_secret?: string; // deprecated: no longer persisted, kept for migration cleanup
  };
  defaults?: Record<string, string>;
}

export class ConfigManager {
  private configPath: string;
  private configDir: string;

  constructor(toolName: string) {
    const configBase = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
    this.configDir = join(configBase, `${toolName}-cli`);
    this.configPath = join(this.configDir, 'config.json');
  }

  getConfigDir(): string {
    return this.configDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  read(): CliConfig {
    if (!existsSync(this.configPath)) return {};
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  write(config: CliConfig): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  }

  get<K extends keyof CliConfig>(key: K): CliConfig[K] {
    return this.read()[key];
  }

  set<K extends keyof CliConfig>(key: K, value: CliConfig[K]): void {
    const config = this.read();
    config[key] = value;
    this.write(config);
  }

  getDefault(key: string): string | undefined {
    return this.read().defaults?.[key];
  }

  setDefault(key: string, value: string): void {
    const config = this.read();
    config.defaults = config.defaults ?? {};
    config.defaults[key] = value;
    this.write(config);
  }

  clear(): void {
    this.write({});
  }
}
