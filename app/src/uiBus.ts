/**
 * 跨组件的「看一眼这里」信号。
 *
 * 存在的理由：AI 产物是**脚本**放上白板的，用户这时可能把白板拖到了别处，
 * 甚至正在看板栏里。卡片放好了但他看不见，就等于"点了没反应"。
 * 白板组件 watch 这个 ref，一有值就把视口挪过去。
 */
import { ref } from "vue";

export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 同一个矩形连续触发也要生效，所以带上序号 */
  seq: number;
}

export const boardFocusRect = ref<FocusRect | null>(null);

/** 把白板视口移到这块区域（坐标是白板逻辑坐标） */
export function focusOnBoard(x: number, y: number, w: number, h: number) {
  boardFocusRect.value = { x, y, w, h, seq: Date.now() };
}
