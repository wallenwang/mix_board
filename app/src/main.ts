import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import "./styles.css";
// 视觉主题层 v3：必须在 styles.css 之后导入（靠"后写覆盖"生效）
import "./theme-lumiere.css";
import App from "./App.vue";
import { api } from "./api";

/** JS 开始执行的时间点：用来区分"解析脚本慢"还是"渲染慢" */
const tJs = performance.now();

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus, { locale: zhCn });
app.mount("#app");

// ⚠️ 启动画面（#splash）**不在这里撤**。
// mount 时 store.loaded 还是 false，真正的界面（看板/白板/文档/浮窗）要等
// bootstrap 之后才渲染 —— 这里撤遮罩就会露出"空壳 + 随后几秒假死"。
// 现在由 App.vue 在首屏真正画完后淡出（见 onMounted 的 finally）。

void api.diagLog(
  `BOOTPERF js-start=${tJs.toFixed(0)}ms mount-done=${performance.now().toFixed(0)}ms`
);
