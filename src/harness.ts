import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PRODUCT_NAME, PRODUCT_VERSION } from './product';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexAuth = {
  token: string; accountId?: string; label: string;
  backendOrigin: string; routingOverride?: string; fedramp?: boolean;
};

// Do not log raw RPC responses: getAuthStatus includes a bearer credential.
export class CodexHarness {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready: Promise<void> | null = null;

  private executable(): string {
    if (process.env.CODEX_BINARY) return process.env.CODEX_BINARY;
    const home = os.homedir();

    // Desktop launchers often start without the login shell's PATH.
    const candidates = process.platform === 'linux' ? [
      path.join(home, '.nix-profile/bin/codex'),
      `/etc/profiles/per-user/${os.userInfo().username}/bin/codex`,
      '/run/current-system/sw/bin/codex',
      path.join(home, '.local/bin/codex'),
      path.join(home, '.npm-global/bin/codex'),
      '/usr/local/bin/codex',
      '/usr/bin/codex',
    ] : [
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ];
    return candidates.find(existsSync) ?? 'codex';
  }

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = this.initialize().catch((error) => {
      if (this.ready === ready) this.dispose();
      throw error;
    });
    this.ready = ready;
    return ready;
  }

  private async initialize(): Promise<void> {
    const child = spawn(this.executable(), ['app-server', '--stdio'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.process = child;
    // Drain logs without forwarding credentials, workspace paths, or user details.
    child.stderr.on('data', () => {});
    child.once('error', () => {
      if (this.process === child) this.rejectPending(new Error('Could not launch the installed Codex harness.'));
    });
    child.once('exit', () => {
      if (this.process === child) {
        this.rejectPending(new Error('The Codex harness stopped. Try reconnecting.'));
        this.process = null; this.ready = null;
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          // RPC errors are intentionally summarized, never echoed wholesale.
          pending.reject(new Error('The installed Codex harness rejected the authentication request.'));
        } else pending.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        // This client only retrieves existing sign-in; it cannot approve agent work.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported in qqdict' } }) + '\n');
      }
    });
    await this.request('initialize', {
      clientInfo: { name: PRODUCT_NAME, title: PRODUCT_NAME, version: PRODUCT_VERSION },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.process;
    if (!child || child.killed) return Promise.reject(new Error('Codex harness is unavailable.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex did not respond within 20 seconds.'));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async getAuth(refreshToken = false): Promise<CodexAuth> {
    await this.connect();
    const result = await this.request('getAuthStatus', { includeToken: true, refreshToken }) as {
      authMethod?: string; authToken?: string | null;
    };
    if (!['chatgpt', 'chatgptAuthTokens'].includes(result.authMethod ?? '') || !result.authToken) {
      throw new Error('Sign in to Codex with ChatGPT, then reconnect. qqdict requires subscription sign-in.');
    }
    let accountId: string | undefined;
    let fedramp = false;
    try {
      const payload = JSON.parse(Buffer.from(result.authToken.split('.')[1], 'base64url').toString('utf8'));
      accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id;
      fedramp = payload['https://api.openai.com/auth']?.chatgpt_account_is_fedramp === true;
    } catch { /* Some managed credentials are opaque. */ }
    const account = await this.request('account/read', { refreshToken: false }) as {
      account?: { type?: string; planType?: string };
      workspaceRouting?: { chatgptAccountId?: string; backendOrigin?: string; accountRoutingOverride?: string } | null;
    };
    const route = account.workspaceRouting;
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const features = await this.request('experimentalFeature/list', { cursor, limit: 100 }) as {
        data?: Array<{ name?: string; enabled?: boolean }>; nextCursor?: string | null;
      };
      if (features.data?.some((feature) => feature.name === 'in_app_dictation' && feature.enabled === false)) {
        throw new Error('Dictation is disabled by your Codex configuration or workspace.');
      }
      cursor = features.nextCursor ?? null;
      if (!cursor) break;
    }
    if (route?.chatgptAccountId && accountId && route.chatgptAccountId !== accountId) {
      throw new Error('Codex reported conflicting workspace identities. Select your account in Codex and reconnect.');
    }
    const backendOrigin = route?.backendOrigin ?? (fedramp ? 'https://gov.chatgpt.com' : 'https://chatgpt.com');
    if (!['https://chatgpt.com', 'https://gov.chatgpt.com'].includes(backendOrigin)) {
      throw new Error('qqdict does not support this managed workspace’s backend route.');
    }
    return {
      token: result.authToken, accountId: route?.chatgptAccountId ?? accountId,
      label: 'Codex sign-in found', backendOrigin, fedramp,
      routingOverride: route?.accountRoutingOverride === 'NO_CONSTRAINT' ? undefined : route?.accountRoutingOverride,
    };
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.rejectPending(new Error('Codex connection closed.'));
    this.process?.kill();
    this.process = null;
    this.ready = null;
  }
}
