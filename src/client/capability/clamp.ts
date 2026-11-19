/**
 * 把一个浮层夹在视口内。
 *
 * 为什么需要：账号抽屉锚在输入框徽标上、向右对齐（`right: 0`）。徽标靠右时一切
 * 正常；**徽标靠左时抽屉会向左溢出视口**——实测 600px 宽、徽标贴左边时 `left`
 * 是 −144px，左侧内容直接看不见。
 *
 * 为什么不用纯 CSS：`position: absolute; right: 0` 无法表达"左边不够就翻到右边"，
 * 而 `transform: translateX(-100%)` 之类的技巧在两侧都可能溢出。现代 CSS 的
 * anchor positioning 还没到能用的普及度。所以用一次 `getBoundingClientRect`
 * 矫正位移，代价是一次布局读。
 *
 * 只在打开时算一次，并在窗口尺寸变化时重算：抽屉打开期间用户几乎不会暴改窗口，
 * 但旋转/分屏会。
 *
 * @module dsh-connect-desktop/client/capability/clamp
 */

import { useCallback, useLayoutEffect, useRef } from 'react'

/** 视口边缘保留的最小空隙（px）。 */
const MARGIN = 8

/**
 * 需要横向平移多少才能把 `rect` 完整放进 `viewport`。
 *
 * 抽成纯函数的原因：位移的真实效果只能在有布局的浏览器里看到，而本仓库的
 * 静态测量页面不执行 React effect，量不到。把它变成纯数学，就能在 Node 里
 * 逐个边界断言——比"在浏览器里点一下看看"可靠。
 *
 * 规则：左侧优先（左侧溢出更常见，因为抽屉右对齐徽标、徽标可能靠左）。
 * `rect` 宽于视口时不再平移——那种情况该由 `max-width` 处理。
 */
export function clampShift(
  rect: { left: number; right: number; width: number },
  viewport: number,
  margin: number = MARGIN,
): number {
  if (rect.width <= 0 || viewport <= 0) return 0
  if (rect.width > viewport - margin * 2) return 0
  if (rect.left < margin) return margin - rect.left
  if (rect.right > viewport - margin) return viewport - margin - rect.right
  return 0
}

export interface ClampHandle<T extends HTMLElement> {
  ref: React.RefObject<T>
  /** 尺寸变化后手动重算（例如内容从加载态变成有数据）。 */
  reclamp: () => void
}

export function useClampToViewport<T extends HTMLElement>(): ClampHandle<T> {
  const ref = useRef<T>(null)

  const reclamp = useCallback(() => {
    const element = ref.current
    if (element === null) return
    // 用元素自己的 window：bundle 在沙箱里跑时，闭包里的 `window` 未必是真 window
    // （测试的模块加载器就是这样），只有 `ownerDocument.defaultView` 一定对。
    const view = element.ownerDocument.defaultView
    if (view === null) return
    // 先归零再量：上一次的位移会污染这一轮的 rect。
    element.style.transform = ''
    const rect = element.getBoundingClientRect()
    // 没有布局的宿主（jsdom）会给出全 0 的 rect：此时平移只会帮倒忙。
    const shift = clampShift(rect, view.innerWidth)
    if (shift !== 0) element.style.transform = `translateX(${Math.round(shift)}px)`
  }, [])

  useLayoutEffect(() => {
    reclamp()
    const view = ref.current?.ownerDocument.defaultView
    if (view === null || view === undefined) return undefined
    view.addEventListener('resize', reclamp)
    return () => view.removeEventListener('resize', reclamp)
  }, [reclamp])

  return { ref, reclamp }
}
