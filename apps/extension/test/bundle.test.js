import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const contentBundlePath = fileURLToPath(new URL('../dist/content.bundle.js', import.meta.url));
const bridgeBundlePath = fileURLToPath(new URL('../dist/bridge.bundle.js', import.meta.url));

describe('Extension Bundle Integrity', () => {
  test('content.bundle.js exists and is within target payload size (<150kb)', () => {
    assert.ok(fs.existsSync(contentBundlePath), 'dist/content.bundle.js must exist');

    const stats = fs.statSync(contentBundlePath);
    assert.ok(stats.size > 10000, 'Bundle must contain engine code');
    assert.ok(stats.size < 150000, `Bundle size should be lightweight, got ${stats.size} bytes`);
  });

  test('bridge.bundle.js exists and exports bridge bootstrap', () => {
    assert.ok(fs.existsSync(bridgeBundlePath), 'dist/bridge.bundle.js must exist');
    const content = fs.readFileSync(bridgeBundlePath, 'utf8');
    assert.ok(content.includes('STREAMSYNC_MAIN_COMMAND'));
  });

  test('evaluates in simulated browser DOM without crashing', () => {
    const bundleCode = fs.readFileSync(contentBundlePath, 'utf8');

    let scriptInjected = false;
    const fakeWindow = {
      location: { hostname: 'www.netflix.com', search: '', href: 'https://www.netflix.com/watch/1' },
      document: {
        title: 'Stranger Things',
        head: {
          appendChild: () => { scriptInjected = true; },
        },
        documentElement: {
          appendChild: () => { scriptInjected = true; },
        },
        createElement: (tag) => {
          return {
            tagName: tag.toUpperCase(),
            style: {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            appendChild: () => {},
            addEventListener: () => {},
            remove: () => {},
            attachShadow: () => ({
              appendChild: () => {},
              querySelector: () => ({
                addEventListener: () => {},
                classList: { add: () => {}, remove: () => {}, toggle: () => {} },
              }),
              querySelectorAll: () => [],
            }),
          };
        },
        body: { appendChild: () => {} },
        getElementById: () => null,
        querySelector: () => null,
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      fetch: async () => ({ json: async () => ({}) }),
    };

    fakeWindow.window = fakeWindow;
    fakeWindow.globalThis = fakeWindow;

    const context = vm.createContext(fakeWindow);
    // Execute bundle inside VM sandbox
    vm.runInContext(bundleCode, context);

    assert.ok(fakeWindow.__STREAMSYNC_RUNTIME__, 'Should create __STREAMSYNC_RUNTIME__ on window');
    assert.equal(scriptInjected, true, 'Should have injected the bridge into document');
  });
});
