/**
 * 产物接线测试 —— 构建出来的 bundle 有没有把该说的话说到。
 *
 * 测的是"注册面"：交给加载器的 id、导出的形状、插槽注册的参数、样式的落点、
 * 以及**失败时不乱抛**。渲染结果不在这里测（那是浏览器里的事）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadBundle, createDocument } from "./harness.mjs";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** 造一个记录一切的 ctx 桩。 */
function createContext(options = {}) {
  const record = {
    effects: [],
    injected: [],
    registered: [],
    services: [],
    errors: [],
    warnings: []
  };
  const ctx = {
    effect(fn, label) {
      record.effects.push({ label });
      const disposer = fn();
      record.effects[record.effects.length - 1].disposer = typeof disposer === "function" ? disposer : null;
      return disposer;
    },
    get(name) {
      record.services.push(name);
      if (options.services && Object.prototype.hasOwnProperty.call(options.services, name)) {
        return options.services[name];
      }
      return undefined;
    },
    slots: options.slots === null
      ? undefined
      : {
        inject(name, callback) {
          record.injected.push({ name });
          const dispose = callback();
          record.injected[record.injected.length - 1].dispose = dispose;
          return () => {};
        },
        register(definition, Component) {
          record.registered.push({ definition, Component });
          return () => {};
        }
      }
  };
  return { ctx, record };
}

test("产物声明的 id 就是包名（改一处必须四处同步的那个 id）", () => {
  const { entry } = loadBundle();
  assert.equal(entry.id, pkg.name);
});

test("工厂返回的导出形状：apply 是函数，inject 只要 slots", () => {
  const { module } = loadBundle();
  assert.equal(typeof module.apply, "function");
  assert.deepEqual(module.inject, ["slots"]);
});

test("apply 把插槽注册到 conversation.input.right，且不占用别人的 id", () => {
  const { module } = loadBundle();
  const { ctx, record } = createContext({ services: { styles: { insert: () => () => {} } } });

  module.apply(ctx);

  assert.equal(record.injected.length, 1, "只应注入一个插槽");
  assert.equal(record.injected[0].name, "conversation.input.right");
  assert.equal(record.registered.length, 1, "注入回调里应恰好注册一个 occupant");

  const { definition, Component } = record.registered[0];
  assert.equal(definition.name, "conversation.input.right");
  assert.equal(definition.id, pkg.name, "occupant 的 id 必须是包名，否则同 id 二次注册会抛");
  assert.equal(typeof definition.order, "number");
  assert.equal(typeof definition.label, "function");
  assert.equal(typeof definition.label(), "string");
  assert.equal(typeof Component, "function");
});

test("样式优先走宿主的 styles 服务；该服务返回的 disposer 原样收下", () => {
  const { module } = loadBundle();
  const inserted = [];
  let disposed = 0;
  const { ctx, record } = createContext({
    services: {
      styles: {
        insert(css) {
          inserted.push(css);
          return () => { disposed += 1; };
        }
      }
    }
  });

  module.apply(ctx);

  assert.equal(inserted.length, 1, "样式应恰好插入一次");
  assert.ok(inserted[0].includes(".dsa-root"), "插入的应是本插件的样式表");
  assert.ok(record.effects.some((item) => /styles/.test(item.label)), "样式应挂在 ctx.effect 上，随插件卸载回收");

  // 全部 effect 的 disposer 都必须是函数、且调用不抛
  for (const effect of record.effects) {
    if (effect.disposer) assert.doesNotThrow(() => effect.disposer());
  }
  assert.equal(disposed, 1, "styles 服务的 disposer 应该被调用一次");
});

test("拿不到 styles 服务时退回自插 <style>，并且卸载时移除它", () => {
  const document = createDocument();
  // 用带记录的 document 加载一次 —— 产物闭包捕获的是传进去的那个 document
  const loaded = loadBundle({ document });
  const fresh = createContext({ services: {} });

  loaded.module.apply(fresh.ctx);

  assert.equal(document.head.children.length, 1, "应往 head 里插一个 style");
  const node = document.head.children[0];
  assert.equal(node.tagName, "STYLE");
  assert.equal(node.getAttribute("data-plugin"), pkg.name);

  const styleEffect = fresh.record.effects.find((item) => /styles/.test(item.label));
  assert.ok(styleEffect && styleEffect.disposer, "自插的 style 必须挂 disposer");
  styleEffect.disposer();
  assert.equal(document.head.children.length, 0, "卸载后 style 必须移除");
});

test("ctx.slots 不可用时：报错、不抛、不留半个注册", () => {
  const { module } = loadBundle();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const { ctx, record } = createContext({ slots: null, services: { styles: { insert: () => () => {} } } });
    assert.doesNotThrow(() => module.apply(ctx));
    assert.equal(record.registered.length, 0);
    assert.ok(errors.some((line) => line.includes(pkg.name)), "必须以插件名报错，不能静默隐身");
  } finally {
    console.error = originalError;
  }
});

test("拿不到 React 运行时时：报错、不抛、完全不碰插槽", () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const { module } = loadBundle({
      requireFn() {
        throw new Error("Cannot find module");
      }
    });
    const { ctx, record } = createContext();
    assert.doesNotThrow(() => module.apply(ctx));
    assert.equal(record.injected.length, 0);
    assert.ok(errors.some((line) => line.includes(pkg.name)));
  } finally {
    console.error = originalError;
  }
});

test("ctx.get 抛异常也不能让 apply 崩掉（宿主服务目录不是我们的责任）", () => {
  const { module } = loadBundle();
  let threw = false;
  const ctx = {
    effect: (fn) => fn(),
    get() {
      throw new Error("service directory exploded");
    },
    slots: {
      inject: () => () => {},
      register: () => () => {}
    }
  };
  try {
    module.apply(ctx);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "apply 绝不能抛 —— 抛了会让这个插件 entry 加载失败");
});

test("组件在只有最小 props 的情况下也能被构造（会话标准属性缺失不炸）", () => {
  const { module } = loadBundle();
  const { ctx, record } = createContext({ services: { styles: { insert: () => () => {} } } });
  module.apply(ctx);
  const { Component } = record.registered[0];
  // 缺 inputActions / useInput：React 桩的 hooks 直接返回值，不该抛
  assert.doesNotThrow(() => Component({}));
});

test("纯函数确实挂在导出上（给后续单测与外部复核用）", () => {
  const { module } = loadBundle();
  const internals = module.__internals;
  for (const name of ["quoteMarkdown", "composeDraft", "isExcludedNode", "clampPosition", "pickLang"]) {
    assert.equal(typeof internals[name], "function", `${name} 应作为可测函数导出`);
  }
  assert.ok(internals.STRINGS.zh && internals.STRINGS.en, "两种语言的文案都要在");
});

test("锚点元素不参与布局（display:none），否则会挤动输入框工具行", () => {
  const { module } = loadBundle();
  const { ctx, record } = createContext({ services: { styles: { insert: () => () => {} } } });
  module.apply(ctx);
  const { Component } = record.registered[0];
  const tree = Component({});
  // React 桩把 createElement(Fragment, …) 还原成 { type, props, children }，
  // 锚点是这一层的第一个孩子。
  const children = Array.isArray(tree) ? tree : (tree && tree.children) || [];
  const anchor = children.find((child) => child && child.props && child.props["data-dsa"] === "anchor");
  assert.ok(anchor, "必须有一个锚点元素用于反查输入框");
  assert.equal(anchor.props.style.display, "none", "锚点不能占位，否则会挤动输入框工具行");
  assert.equal(anchor.props["data-dsa"], "anchor");
});
