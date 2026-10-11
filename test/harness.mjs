/**
 * 测试脚手架：在 Node 里把构建产物当**脚本**跑一遍，抓住它交给模块加载器的那份声明。
 *
 * 为什么不用 `import`：
 *   `lib/client.js` 不是 ES 模块（它没有 `export`，只有一句
 *   `window.__ModuleLoader__.load({...})`），而且导入缓存会让"同一份产物跑两次"
 *   变成"跑一次"。用 `new Function` 显式喂进 window / document / navigator，
 *   既躲开缓存，也让每个用例拿到干净的桩。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ─────────────────────────── DOM 桩 ─────────────────────────── */

/** 造一个元素桩：只实现插件真的碰到的那几个面。 */
export function el(tagName, attributes = {}, children = []) {
  const node = {
    // 真 DOM 里元素节点恒为 1；桩里漏掉它会让 `node.nodeType === 1` 判定走错分支，
    // 测试就会对着一个"永远 false"的实现点头。
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    attributes: { ...attributes },
    children: [],
    parentElement: null,
    style: { cssText: "" },
    dataset: {},
    isConnected: true,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentElement = null;
      return child;
    },
    querySelector() {
      return null;
    },
    closest(selector) {
      let cursor = this;
      while (cursor) {
        if (selector === "[data-selection-ask]" && cursor.hasAttribute("data-selection-ask")) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    }
  };
  for (const child of children) node.appendChild(child);
  return node;
}

/** 造一个 document 桩：head / body 都是真元素，appendChild 记录得下来。 */
export function createDocument() {
  const head = el("head");
  const body = el("body");
  const listeners = [];
  return {
    head,
    body,
    listeners,
    createElement: (tag) => el(tag),
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex((item) => item.type === type && item.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    querySelector: () => null
  };
}

/* ─────────────────────────── React 桩 ─────────────────────────── */

/**
 * React 桩：只要**形状对**就够了 —— 这些用例测的是插件的接线（注册了什么、
 * 拿到了什么、有没有乱抛），不是渲染结果。渲染留给浏览器里的人工实测。
 */
export function createReactStub() {
  const calls = { createElement: 0, useState: 0, useEffect: 0, useLayoutEffect: 0, useCallback: 0, useRef: 0 };
  const React = {
    Fragment: Symbol("Fragment"),
    createElement(...args) {
      calls.createElement += 1;
      return { type: args[0], props: args[1] ?? null, children: args.slice(2) };
    },
    useRef(initial) {
      calls.useRef += 1;
      return { current: initial ?? null };
    },
    useState(initial) {
      calls.useState += 1;
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useEffect() {
      calls.useEffect += 1;
    },
    useLayoutEffect() {
      calls.useLayoutEffect += 1;
    },
    useCallback(fn) {
      calls.useCallback += 1;
      return fn;
    },
    memo: (component) => component
  };
  const ReactDOM = {
    createPortal(node, container) {
      return { portal: node, container };
    }
  };
  return { React, ReactDOM, calls };
}

/** 平台模块表 require 的桩：只认 react / react-dom，其余按加载器行为抛错。 */
export function createRequire(stubs) {
  return function require(name) {
    if (name === "react") return stubs.React;
    if (name === "react-dom") return stubs.ReactDOM;
    throw new Error(`Cannot find module '${name}'`);
  };
}

/* ─────────────────────── 加载构建产物 ─────────────────────── */

/**
 * 跑一遍 `lib/client.js`，返回它交给加载器的入口声明与模块导出。
 *
 * @param {{document?: object, navigator?: object, requireFn?: Function}} [options]
 * @returns {{entry: {id: string, factory: Function}, module: object, dom: object, react: object}}
 */
export function loadBundle(options = {}) {
  const source = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
  const dom = options.document ?? createDocument();
  const react = createReactStub();
  const requireFn = options.requireFn ?? createRequire(react);
  const navigator = options.navigator ?? { language: "zh-CN" };

  let entry = null;
  const windowStub = {
    __ModuleLoader__: {
      load(declaration) {
        entry = declaration;
      }
    },
    requestAnimationFrame: (fn) => {
      fn(0);
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    getSelection: () => null
  };

  // eslint-disable-next-line no-new-func -- 产物是脚本不是模块，只能用这种方式喂桩
  const run = new Function("window", "document", "navigator", source);
  run(windowStub, dom, navigator);

  if (entry === null) throw new Error("产物没有调用 window.__ModuleLoader__.load");
  const module = entry.factory(requireFn);
  return { entry, module, dom, react, window: windowStub };
}
