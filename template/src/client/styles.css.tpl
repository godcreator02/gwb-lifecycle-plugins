/*
 * 本插件的样式入口。插件自己就是一个完整的 Tailwind 入口，围栏靠**类名前缀**：
 * 类名从源头就是 `{{name}}:flex` 这种，全页有效但只可能匹配本插件画出来的元素
 * ——弹层 portal 到 body 照样有样式，容器上的 data-gwb-plugin 只是身份标记。
 *
 * 四行 import 各有各的必要，一条都不能省：
 * - `tailwindcss/theme.css` + `theme(reference)` + `prefix({{name}})`：引进内置主题让类名
 *   解析得出来，但一个变量声明都不输出；prefix 写在这条拆开的 import 上才生效。
 * - 令牌包的 `theme.reference.css`：语义色的映射面。**不引它颜色类整个是空的**（静默）。
 * - `tailwindcss/utilities.css`：只引工具类不引 preflight（preflight 全局一份归令牌包）；
 *   `source(none)` 关掉自动扫描，扫描面只认下面那条 `@source`。
 * - `tw-animate-css`：`animate-in` 一族。不引它们一个字节都不出（静默）。
 *
 * `@source "./"` 相对本文件，只扫 src/client。别写 `:root { --primary: … }`——令牌是
 * 页面共享那份，在这儿改要么盖全页要么跟别处不一致。
 */

@import 'tailwindcss/theme.css' theme(reference) prefix({{name}});
@import '@team/gwb-tokens/theme.reference.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(utilities) source(none);
@import 'tw-animate-css';
@source "./";
