/** Block mouse-wheel from nudging focused <input type="number"> values. */
export function initDisableNumberInputScroll(): void {
  if (typeof document === 'undefined') return

  document.addEventListener(
    'wheel',
    event => {
      const target = event.target
      if (
        target instanceof HTMLInputElement &&
        target.type === 'number' &&
        document.activeElement === target
      ) {
        event.preventDefault()
      }
    },
    { passive: false, capture: true },
  )
}
