// @ts-check
// ============================================================
// SHARED UTILITIES — small pure helpers used across the codebase.
// ============================================================
// Consolidates idioms that were previously copy-pasted in dozens of
// places: uniform-random integer / element / range picks, in-place
// Fisher-Yates shuffle, numeric clamp, and the `cost-N` CSS class
// builder shared by the deckbuilder / roguelite renderers.
//
// Loaded FIRST in index.html (before cards.js) and in sim/shim.js so
// every downstream file can reach `Util.*`. No build step — plain
// global namespace, matching CombatEngine / Game / UI / AI / etc.
//
// Every helper is behavior-identical to the inline code it replaces:
//   - randInt(n)        === Math.floor(Math.random() * n)
//   - pickRandom(arr)   === arr[Math.floor(Math.random() * arr.length)]
//   - randRange(lo, hi) === lo + Math.floor(Math.random() * (hi - lo + 1))
//   - shuffleInPlace    === the standard reverse Fisher-Yates loop
//   - clamp(v, lo, hi)  === Math.max(lo, Math.min(hi, v))
// so they consume the RNG stream the same way and never shift sim
// balance or test outcomes.

const Util = {
  /**
   * Uniform random integer in [0, n). Matches `Math.floor(Math.random() * n)`.
   * @param {number} n
   * @returns {number}
   */
  randInt(n) {
    return Math.floor(Math.random() * n);
  },

  /**
   * Uniform random integer in [lo, hi] inclusive.
   * Matches `lo + Math.floor(Math.random() * (hi - lo + 1))`.
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  randRange(lo, hi) {
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  },

  /**
   * Uniformly pick one element of an array (undefined when empty).
   * Matches `arr[Math.floor(Math.random() * arr.length)]`.
   * @template T
   * @param {ArrayLike<T>} arr
   * @returns {T}
   */
  pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  },

  /**
   * In-place reverse Fisher-Yates shuffle. Returns the same array.
   * @template T
   * @param {T[]} arr
   * @returns {T[]}
   */
  shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  },

  /**
   * Fisher-Yates shuffle of a shallow copy; leaves the input untouched.
   * @template T
   * @param {T[]} arr
   * @returns {T[]}
   */
  shuffled(arr) {
    return this.shuffleInPlace(arr.slice());
  },

  /**
   * Clamp a number to [lo, hi]. Matches `Math.max(lo, Math.min(hi, v))`.
   * @param {number} v
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  },

  /**
   * Build the `cost-N` CSS class used by card renderers, clamping the
   * cost into the 0..10 sprite range.
   * Matches `'cost-' + Math.min(10, Math.max(0, cost))`.
   * @param {number} cost
   * @returns {string}
   */
  costClass(cost) {
    return 'cost-' + Math.min(10, Math.max(0, cost));
  },
};

// Expose globally — matches the rest of the codebase's namespace style
// (CombatEngine, Roguelite, Game, UI, AI, Multiplayer are top-level globals).
if (typeof globalThis !== 'undefined') globalThis.Util = Util;
else if (typeof window !== 'undefined') window.Util = Util;
