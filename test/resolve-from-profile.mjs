/**
 * 从某个 profile 目录出发，用 Node 自己的解析器验证插件包能不能被解析到。
 *
 * 为什么要有这个：宿主加载插件 entry 走的就是 Node 的模块解析，
 * 手写 `Test-Path` 只能证明"文件在那儿"，证明不了"解析器认它" ——
 * 而解析失败会让整个 entry 加载失败。
 *
 * 用法：`node test/resolve-from-profile.mjs <profile 目录> [包名]`
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const from = process.argv[2];
const name = process.argv[3] ?? "dsh-selection-ask";
if (!from) {
  process.stderr.write("用法：node test/resolve-from-profile.mjs <profile 目录> [包名]\n");
  process.exit(2);
}

const base = /[\\/]$/.test(from) ? from : from + "\\";
const requireFrom = createRequire(base);

let resolved;
try {
  resolved = requireFrom.resolve(name);
} catch (error) {
  process.stderr.write(`✗ 解析失败：${error.code ?? ""} ${error.message}\n`);
  process.exit(1);
}

const pkg = requireFrom.resolve(`${name}/package.json`);
const manifest = JSON.parse(readFileSync(pkg, "utf8"));
process.stdout.write(`✓ 解析成功\n`);
process.stdout.write(`  入口     ${resolved}\n`);
process.stdout.write(`  manifest ${pkg}\n`);
process.stdout.write(`  dsh.client ${JSON.stringify(manifest.dsh?.client ?? null)}\n`);
