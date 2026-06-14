import { _electron, test as base, TestInfo, TraceMode, type ElectronApplication, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { ObjectHandle, VSCode, VSCodeEvaluator, VSCodeFunctionOn, VSCodeHandle } from './vscodeHandle';
export { expect } from '@playwright/test';

export type VSCodeWorkerOptions = {
  vscodeVersion: string;
  extensions?: string | string[];
  vscodeTrace: TraceMode | { mode: TraceMode, snapshots?: boolean, screenshots?: boolean, sources?: boolean, attachments?: boolean };
  extensionsDir?: string;
  userDataDir?: string;
}

export type VSCodeTestOptions = {
  // VS Code accepts repeated --extensionDevelopmentPath args, so an array
  // loads multiple development extensions (e.g. an extension plus another
  // extension it hard-depends on via extensionDependencies).
  extensionDevelopmentPath?: string | string[];
  baseDir: string;
  // User-level settings merged into <userDataDir>/User/settings.json before
  // launch. Use for window/application-scoped settings that a workspace
  // settings file cannot override — notably { 'window.menuStyle': 'custom' },
  // which makes VS Code render DOM context menus (.context-view .monaco-menu)
  // instead of native OS menus, so Playwright can right-click and assert them.
  userSettings?: Record<string, unknown>;
};

type VSCodeTestFixtures = {
  electronApp: ElectronApplication,
  workbox: Page,
  evaluateInVSCode<R>(vscodeFunction: VSCodeFunctionOn<VSCode, void, R>): Promise<R>;
  evaluateInVSCode<R, Arg>(vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>, arg: Arg): Promise<R>;
  evaluateHandleInVSCode<R>(vscodeFunction: VSCodeFunctionOn<VSCode, void, R>): Promise<VSCodeHandle<R>>,
  evaluateHandleInVSCode<R, Arg>(vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>, arg: Arg): Promise<VSCodeHandle<R>>,
};

type ExperimentalVSCodeTestFixtures = {
  _enableRecorder: void;
}

type InternalWorkerFixtures = {
  _createTempDir: () => Promise<string>;
  _vscodeInstall: { installPath: string, cachePath: string };
}

type InternalTestFixtures = {
  _serverInfoFile: string,
  _evaluator: VSCodeEvaluator,
  _vscodeHandle: ObjectHandle<VSCode>,
}

function shouldCaptureTrace(traceMode: TraceMode, testInfo: TestInfo) {
  if (process.env.PW_TEST_DISABLE_TRACING)
    return false;

  if (traceMode === 'on')
    return true;

  if (traceMode === 'retain-on-failure')
    return true;

  if (traceMode === 'on-first-retry' && testInfo.retry === 1)
    return true;

  if (traceMode === 'on-all-retries' && testInfo.retry > 0)
    return true;

  if (traceMode === 'retain-on-first-failure' && testInfo.retry === 0)
    return true;

  return false;
}

function getTraceMode(trace: TraceMode | 'retry-with-trace' | { mode: TraceMode; snapshots?: boolean; screenshots?: boolean; sources?: boolean; attachments?: boolean; }) {
  const traceMode = typeof trace === 'string' ? trace : trace.mode;
  if (traceMode === 'retry-with-trace')
    return 'on-first-retry';
  return traceMode;
}

export const test = base.extend<VSCodeTestFixtures & VSCodeTestOptions & InternalTestFixtures& ExperimentalVSCodeTestFixtures, VSCodeWorkerOptions & InternalWorkerFixtures>({
  vscodeVersion: ['insiders', { option: true, scope: 'worker' }],
  extensions: [undefined, { option: true, scope: 'worker' }],
  vscodeTrace: ['off', { option: true, scope: 'worker' }],
  extensionDevelopmentPath: [undefined, { option: true }],
  baseDir: [async ({ _createTempDir }, use) => await use(await _createTempDir()), { option: true }],
  userSettings: [undefined, { option: true }],
  extensionsDir: [undefined, { option: true, scope: 'worker' }],
  userDataDir: [undefined, { option: true, scope: 'worker' }],

  _vscodeInstall: [async ({ _createTempDir, vscodeVersion, extensions, extensionsDir, userDataDir }, use, workerInfo) => {
    const cachePath = await _createTempDir();
    const installBasePath = path.join(process.cwd(), '.vscode-test', `worker-${workerInfo.parallelIndex}`);
    await fs.promises.mkdir(installBasePath, { recursive: true });
    const installPath = await downloadAndUnzipVSCode({ cachePath: installBasePath, version: vscodeVersion });
    const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(installPath);

    if (extensions) {
      await new Promise<void>((resolve, reject) => {
        extensions = typeof extensions === 'string' ? [extensions] : (extensions ?? []);
        const subProcess = cp.spawn(
          cliPath,
          [
            `--extensions-dir=${extensionsDir ?? path.join(cachePath, 'extensions')}`,
            `--user-data-dir=${userDataDir ?? path.join(cachePath, 'user-data')}`,
            ...extensions.flatMap(extension => ['--install-extension', extension])
          ],
          {
            stdio: 'inherit',
            shell: os.platform() === 'win32',
          }
        );
        subProcess.on('exit', (code, signal) => {
          if (!code)
            resolve();
          else
            reject(new Error(`Failed to install extensions: code = ${code}, signal = ${signal}`));
        });
      });

    }

    await use({ installPath, cachePath });
  }, { timeout: 0, scope: 'worker' }],

  // based on https://github.com/microsoft/playwright-vscode/blob/1d855b9a7aeca783223a7a9f8e3b01efbe8e16f2/tests-integration/tests/baseTest.ts
  _serverInfoFile: [async ({ _vscodeInstall }, use, testInfo) => {
    const file = path.join(_vscodeInstall.cachePath, `vscode-test-server-${testInfo.testId}.txt`);
    await fs.promises.rm(file, { force: true });
    await use(file);
    await fs.promises.rm(file, { force: true });
  }, {}],

  electronApp: [async ({ extensionDevelopmentPath, baseDir, _vscodeInstall, vscodeTrace, trace, extensionsDir, userDataDir, userSettings, _serverInfoFile }, use, testInfo) => {
    const { installPath, cachePath } = _vscodeInstall;

    // Window/application-scoped settings (e.g. window.menuStyle) must exist in
    // the user-data-dir's settings.json at launch — a workspace settings file
    // cannot override them. Merge userSettings before VS Code starts.
    const effectiveUserDataDir = userDataDir ?? path.join(cachePath, 'user-data');
    if (userSettings) {
      const userDir = path.join(effectiveUserDataDir, 'User');
      await fs.promises.mkdir(userDir, { recursive: true });
      const settingsFile = path.join(userDir, 'settings.json');
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8')) as Record<string, unknown>;
      } catch {
        // no pre-existing settings.json
      }
      await fs.promises.writeFile(
        settingsFile,
        JSON.stringify({ ...existing, ...userSettings }, null, 2),
        'utf8'
      );
    }

    // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
    // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
    const env = { ...process.env } as Record<string, string>;
    for (const prop in env) {
      if (/^VSCODE_/i.test(prop))
        delete env[prop];
    }

    // Tells the injected VSCodeTestServer where to write its address (see
    // src/injected/index.ts) so the _evaluator fixture can discover it
    // without relying on playwright internals.
    env.PW_VSCODE_TEST_SERVER_FILE = _serverInfoFile;

    const electronApp = await _electron.launch({
      executablePath: installPath,
      env,
      args: [
        // Stolen from https://github.com/microsoft/vscode-test/blob/0ec222ef170e102244569064a12898fb203e5bb7/lib/runTest.ts#L126-L160
        // https://github.com/microsoft/vscode/issues/84238
        '--no-sandbox',
        // https://github.com/microsoft/vscode-test/issues/221
        '--disable-gpu-sandbox',
        // https://github.com/microsoft/vscode-test/issues/120
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--extensions-dir=${extensionsDir ?? path.join(cachePath, 'extensions')}`,
        `--user-data-dir=${effectiveUserDataDir}`,
        `--extensionTestsPath=${path.join(__dirname, 'injected', 'index')}`,
        ...(extensionDevelopmentPath ? [extensionDevelopmentPath].flat().map(p => `--extensionDevelopmentPath=${p}`) : []),
        baseDir,
      ],
    });

    const traceMode = getTraceMode(vscodeTrace);
    const captureTrace = shouldCaptureTrace(traceMode, testInfo);
    const context = electronApp.context();
    if (captureTrace) {
      const { screenshots, snapshots } = typeof vscodeTrace !== 'string' ? vscodeTrace : { screenshots: true, snapshots: true };
      await context.tracing.start({ screenshots, snapshots, title: testInfo.title });
    }

    await use(electronApp);

    if (captureTrace) {
      const testFailed = testInfo.status !== testInfo.expectedStatus;
      const shouldAbandonTrace = !testFailed && (traceMode === 'retain-on-failure' || traceMode === 'retain-on-first-failure');
      if (!shouldAbandonTrace) {
        // if default trace is not off, use vscode-trace to avoid conflicts
        const traceName = getTraceMode(trace) === 'off' ? 'trace' : 'vscode-trace';
        const tracePath = testInfo.outputPath(`${traceName}.zip`);
        await context.tracing.stop({ path: tracePath });
        testInfo.attachments.push({ name: traceName, path: tracePath, contentType: 'application/zip' });
      }
    }

    await electronApp.close();

    const logPath = path.join(cachePath, 'user-data', 'logs');
    if (fs.existsSync(logPath)) {
      const logOutputPath = test.info().outputPath('vscode-logs');
      await fs.promises.cp(logPath, logOutputPath, { recursive: true });
    }
  }, { timeout: 0 }],

  workbox: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow());
  },

  page: ({ workbox }, use) => use(workbox),

  context: ({ electronApp }, use) => use(electronApp.context()),

  _evaluator: async ({ playwright, electronApp, workbox, vscodeTrace, _serverInfoFile }, use, testInfo) => {
    // electronApp must be launched before we can wait for its server.
    void electronApp;
    // The injected VSCodeTestServer writes its address to _serverInfoFile
    // (via the PW_VSCODE_TEST_SERVER_FILE env var) — poll for it instead of
    // scraping process stderr through playwright internals.
    const deadline = Date.now() + 30_000;
    let serverUrl: string | undefined;
    while (Date.now() < deadline) {
      try {
        const content = await fs.promises.readFile(_serverInfoFile, 'utf8');
        if (content.trim()) {
          serverUrl = content.trim();
          break;
        }
      } catch {}
      await new Promise(f => setTimeout(f, 100));
    }
    if (!serverUrl)
      throw new Error(`Timed out waiting for VSCodeTestServer address in ${_serverInfoFile}. Is the extension host running?`);
    const ws = new WebSocket(serverUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const traceMode = getTraceMode(vscodeTrace);
    const captureTrace = shouldCaptureTrace(traceMode, testInfo);
    // playwright._toImpl was removed from newer playwright versions. When it
    // is unavailable, vscode evaluation calls are simply not recorded in the
    // trace (UI tracing is unaffected) — see VSCodeEvaluator.
    let pageImpl: any;
    const toImpl = (playwright as any)._toImpl;
    if (captureTrace && typeof toImpl === 'function') {
      try {
        pageImpl = await toImpl.call(playwright, workbox);
      } catch {}
    }
    const evaluator = new VSCodeEvaluator(ws, pageImpl);
    await use(evaluator);
    ws.close();
  },

  _vscodeHandle: async ({ _evaluator }, use) => {
    await use(_evaluator.rootHandle());
  },

  evaluateInVSCode: async ({ _vscodeHandle }, use) => {
    // @ts-ignore
    await use((fn, arg) => _vscodeHandle.evaluate(fn, arg));
  },

  evaluateHandleInVSCode: async ({ _vscodeHandle }, use) => {
    const handles: ObjectHandle<unknown>[] = [];
    // @ts-ignore
    await use(async (fn, arg) => {
      const handle = await _vscodeHandle.evaluateHandle(fn, arg);
      handles.push(handle);
      return handle;
    });
    await Promise.all(handles.map(h => h.release()));
  },

  _createTempDir: [async ({ }, use) => {
    const tempDirs: string[] = [];
    await use(async () => {
      const tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtest-')));
      await fs.promises.mkdir(tempDir, { recursive: true });
      tempDirs.push(tempDir);
      return tempDir;
    });
    for (const tempDir of tempDirs)
      await fs.promises.rm(tempDir, { recursive: true });
  }, { scope: 'worker' }],

  _enableRecorder: [async ({ playwright, context }, use) => {
    const skip = !!process.env.CI;
    let closePromise: Promise<void> | undefined;
    if (!skip) {
      await (context as any)._enableRecorder({
        language: 'playwright-test',
        mode: 'recording',
      });
      const contextImpl = await (playwright as any)._toImpl(context);
      closePromise = new Promise(resolve => contextImpl.recorderAppForTest.once('close', resolve));
    }
    await use();
    if (closePromise)
      await closePromise;
  }, { timeout: 0 }],

});
