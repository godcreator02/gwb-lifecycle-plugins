/*
 * 本插件的样式入口。插件自己就是一个完整的 Tailwind 入口，样式只作用于本插件靠的是**类名前缀**：
 * 类名从源头就是 `{{cssPrefix}}:flex` 这种，全页有效但只可能匹配本插件画出来的元素
 * ——弹层 portal 到 body 照样有样式，容器上的 data-gwb-plugin 只是身份标记。前缀是短名
 * 去掉非小写字母：Tailwind 4 的 prefix 只收 a-z，含连字符或数字直接报错。
 *
 * 四行 import 各有各的必要，一条都不能省：
 * - `tailwindcss/theme.css` + `theme(reference)` + `prefix({{cssPrefix}})`：引进内置主题让类名
 *   解析得出来，但一个变量声明都不输出；prefix 写在这条拆开的 import 上才生效。
 * - 外壳导出的 `theme.reference.css`：把语义色等令牌映射到页面变量。**不引它颜色类全是空的**，而且不报错。
 * - `tailwindcss/utilities.css`：只引工具类不引 preflight（preflight 全页一份，在外壳导出的 theme.css 里）；
 *   `source(none)` 关掉自动扫描，只扫下面那条 `@source` 指定的目录。
 * - `tw-animate-css`：`animate-in` 这一组动画类。不引它们一个字节都不输出，而且不报错。
 *
 * `@source "./"` 相对本文件，只扫 src/client。别写 `:root { --primary: … }`——令牌的值全页
 * 共用一份，由外壳提供，在这儿改要么覆盖全页要么跟别处不一致。
 */

@import 'tailwindcss/theme.css' theme(reference) prefix({{cssPrefix}});
@import '@godcreator/gwb-shell/theme.reference.css' theme(reference);
@import 'tailwindcss/utilities.css' layer(utilities) source(none);
@import 'tw-animate-css';
@source "./";
