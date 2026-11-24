/** Request guard: only the most recently started request may apply its result. */
export function createLatest() {
  let id = 0;
  return {
    /** Start a request; the returned check is true only while it is still the latest. */
    start(): () => boolean {
      const mine = ++id;
      return () => mine === id;
    },
  };
}
