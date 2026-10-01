// ============================================================
// A DOM REAL ENOUGH TO ASSERT AGAINST — so ui.js can be RUN, not grepped.
//
//   load('./sim/shim-dom.js');   // gives you Game AND the real UI
//
// WHY. ui.js is 40,106 lines, 27% of the codebase, and no test could execute a
// line of it: 28 suites in sim/ `read('ui.js')` as TEXT and match regexes
// against the source. That verifies the code LOOKS right, which is a different
// claim from working — and it is why several visual fixes in this repo's
// history shipped inert. A selector that matches nothing, a class never added,
// a rule out-specified: all of them pass a grep.
//
// The existing sim/shim.js keeps its thin UI STUB and is untouched — 500+ cases
// depend on it, and they must keep running against exactly what they ran
// against before. This is a SECOND harness for suites that want the real thing.
//
// WHAT IT IS NOT. Not a browser. There is no layout, no cascade, no paint, so
// it cannot answer "what does this look like" — that is what the headless
// Chrome fixtures are for. What it answers is everything upstream of paint:
// which elements got built, what classes and attributes they carry, what text
// they hold, what a renderer does with a given state. That is the half that
// grep was pretending to check.
// ============================================================

var __SIM_ROOT_OVERRIDE = (typeof __SIM_ROOT_OVERRIDE !== 'undefined') ? __SIM_ROOT_OVERRIDE : '.';
load('./sim/shim.js');

// ---- a small, honest DOM ----------------------------------------------
(function () {
  var VOID = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1 };

  function ClassList(el) { this._el = el; }
  ClassList.prototype._list = function () {
    return String(this._el.className || '').split(/\s+/).filter(Boolean);
  };
  ClassList.prototype._set = function (a) { this._el.className = a.join(' '); };
  ClassList.prototype.add = function () {
    var a = this._list();
    for (var i = 0; i < arguments.length; i++) {
      String(arguments[i]).split(/\s+/).filter(Boolean).forEach(function (c) {
        if (a.indexOf(c) < 0) a.push(c);
      });
    }
    this._set(a);
  };
  ClassList.prototype.remove = function () {
    var a = this._list(), drop = [];
    for (var i = 0; i < arguments.length; i++) drop.push(String(arguments[i]));
    this._set(a.filter(function (c) { return drop.indexOf(c) < 0; }));
  };
  ClassList.prototype.contains = function (c) { return this._list().indexOf(String(c)) >= 0; };
  ClassList.prototype.toggle = function (c, force) {
    var has = this.contains(c);
    var want = (force === undefined) ? !has : !!force;
    if (want) this.add(c); else this.remove(c);
    return want;
  };
  Object.defineProperty(ClassList.prototype, 'length', {
    get: function () { return this._list().length; }
  });

  function Style() {}
  // ui.js assigns style.cssText at 49 sites. Without this the string was stored
  // as a plain property and the declarations in it were never parsed — so the
  // styles were invisible to getComputedStyle and to outerHTML, and a suite
  // reading style.width after a cssText write got undefined.
  Object.defineProperty(Style.prototype, 'cssText', {
    get: function () {
      return Object.keys(this).map(function (k) { return k + ': ' + this[k]; }, this).join('; ');
    },
    set: function (v) {
      Object.keys(this).forEach(function (k) { delete this[k]; }, this);
      String(v == null ? '' : v).split(';').forEach(function (decl) {
        var i = decl.indexOf(':');
        if (i < 0) return;
        var k = decl.slice(0, i).trim(), val = decl.slice(i + 1).trim();
        if (k) this[k] = val;
      }, this);
    }
  });
  Style.prototype.setProperty = function (k, v) { this[k] = v; };
  Style.prototype.getPropertyValue = function (k) { return this[k] != null ? this[k] : ''; };
  Style.prototype.removeProperty = function (k) { delete this[k]; };

  function El(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    // childNodes is the REAL list; children is element-only, as in a browser.
    // Aliasing the two put text nodes into `children`, and ui.js iterates
    // `.children` at ten sites — including renderBoard's
    // `Array.from(this.board.children)` and the hand differ's index maths
    // (`listEl.children[i] !== el` → `insertBefore(el, listEl.children[i])`).
    // With whitespace in the parent those indices differ from the browser's, so
    // a reorder assertion could pass here and be wrong on the page.
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.style = new Style();
    // A LIVE VIEW ON data-* ATTRIBUTES, BOTH WAYS. setAttribute populated this
    // object, but a write to it created nothing — so of the ~104 `.dataset.*`
    // writes in ui.js, not one became an attribute, `getAttribute('data-…')`
    // returned null and `[data-…]` selectors matched nothing. Worse than a
    // missing match: sim/ui-render.js's face-down case asserts
    // `getAttribute('data-card-id') === null`, which would have passed on a
    // card that leaked its id through dataset — a security-ish test quietly
    // unable to fail.
    this.dataset = __dataset(this);
    this.attributes = {};
    this._text = '';
    this._listeners = {};
    this.classList = new ClassList(this);
    // Geometry is meaningless without layout; these exist so a renderer that
    // measures does not throw, and any suite that reads them is measuring
    // nothing and should say so.
    this.offsetWidth = 0; this.offsetHeight = 0;
    this.scrollWidth = 0; this.scrollHeight = 0;
    this.value = '';
    this.checked = false;
  }
  El.prototype.appendChild = function (c) {
    if (!c) return c;
    // A DocumentFragment is a CARRIER: appending it moves its children in and
    // leaves the fragment empty. Treating it as an ordinary node inserted the
    // fragment itself, so host.children[0] was `#FRAGMENT`, outerHTML emitted a
    // literal <#fragment>, and every renderer that batches through one built a
    // tree the browser never builds.
    if (c.tagName === '#FRAGMENT') {
      c.childNodes.slice().forEach(function (k) { this.appendChild(k); }, this);
      return c;
    }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  };
  El.prototype.append = function () {
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      this.appendChild(typeof a === 'string' ? __textNode(a) : a);
    }
  };
  El.prototype.removeChild = function (c) {
    var i = this.childNodes.indexOf(c);
    if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
    return c;
  };
  El.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  El.prototype.insertBefore = function (c, ref) {
    var i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.splice(i, 0, c);
    return c;
  };
  El.prototype.setAttribute = function (k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'id') this.id = String(v);
    // (no dataset mirroring needed — attributes ARE the dataset's backing store)
  };
  El.prototype.getAttribute = function (k) {
    if (k === 'class') return this.className || null;
    return this.attributes[k] != null ? this.attributes[k] : null;
  };
  El.prototype.hasAttribute = function (k) { return this.getAttribute(k) != null; };
  El.prototype.removeAttribute = function (k) { delete this.attributes[k]; if (k === 'class') this.className = ''; };
  El.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
  El.prototype.removeEventListener = function (t, fn) {
    var a = this._listeners[t] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  El.prototype.dispatchEvent = function (ev) {
    (this._listeners[(ev && ev.type) || ''] || []).forEach(function (fn) { try { fn(ev); } catch (e) {} });
    return true;
  };
  El.prototype.click = function () { this.dispatchEvent({ type: 'click', target: this }); };
  El.prototype.focus = function () {}; El.prototype.blur = function () {};
  El.prototype.getBoundingClientRect = function () {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  };
  El.prototype.closest = function (sel) {
    var n = this;
    while (n) { if (__matches(n, sel)) return n; n = n.parentNode; }
    return null;
  };
  El.prototype.matches = function (sel) { return __matches(this, sel); };
  El.prototype.contains = function (n) {
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  };
  // SHALLOW BY DEFAULT, like the DOM. `deep !== false` made a bare
  // cloneNode() copy the whole subtree, so any of ui.js's seven call sites
  // relying on the default built a tree here that the browser never builds.
  El.prototype.cloneNode = function (deep) {
    var c = new El(this.tagName);
    c.className = this.className;
    c.id = this.id;
    Object.keys(this.attributes).forEach(function (k) { c.attributes[k] = this.attributes[k]; }, this);
    Object.keys(this.style).forEach(function (k) { c.style[k] = this.style[k]; }, this);
    c._text = this._text;
    if (deep) this.childNodes.forEach(function (ch) { c.appendChild(ch.cloneNode(true)); });
    return c;
  };
  El.prototype.querySelector = function (sel) { return __find(this, sel, true)[0] || null; };
  El.prototype.querySelectorAll = function (sel) { return __find(this, sel, false); };

  // textContent: reading walks the tree; writing replaces all children.
  Object.defineProperty(El.prototype, 'textContent', {
    get: function () {
      if (!this.childNodes.length) return this._text;
      return this.childNodes.map(function (c) { return c.textContent; }).join('');
    },
    set: function (v) { this.childNodes.length = 0; this._text = String(v == null ? '' : v); }
  });
  // innerHTML: a deliberately NAIVE parser. It handles the shapes this codebase
  // actually writes — nested tags with class/id/data- attributes and text — and
  // nothing else. It exists so a renderer that builds markup as a string can be
  // inspected as a tree; a suite needing real parsing should assert on the
  // string instead, and say so.
  Object.defineProperty(El.prototype, 'innerHTML', {
    get: function () {
      return this.childNodes.map(function (c) { return c.outerHTML; }).join('') || this._text;
    },
    set: function (html) {
      this.childNodes.length = 0; this._text = '';
      __parseInto(this, String(html == null ? '' : html));
    }
  });
  Object.defineProperty(El.prototype, 'outerHTML', {
    get: function () {
      if (this.tagName === '#TEXT') return this._text;
      var t = this.tagName.toLowerCase(), a = '';
      if (this.className) a += ' class="' + this.className + '"';
      if (this.id) a += ' id="' + this.id + '"';
      Object.keys(this.attributes).forEach(function (k) {
        if (k === 'class' || k === 'id') return;
        a += ' ' + k + '="' + this.attributes[k] + '"';
      }, this);
      if (VOID[t]) return '<' + t + a + '>';
      return '<' + t + a + '>' + this.innerHTML + '</' + t + '>';
    }
  });
  // element-only view of childNodes
  Object.defineProperty(El.prototype, 'children', {
    get: function () { return this.childNodes.filter(function (c) { return c.tagName !== '#TEXT'; }); }
  });
  Object.defineProperty(El.prototype, 'childElementCount', {
    get: function () { return this.children.length; }
  });
  Object.defineProperty(El.prototype, 'parentElement', {
    get: function () {
      var p = this.parentNode;
      return (p && p.tagName && p.tagName !== '#DOCUMENT' && p.tagName !== '#FRAGMENT') ? p : null;
    }
  });
  function __sib(el, dir) {
    var p = el.parentNode;
    if (!p) return null;
    var kids = p.children, i = kids.indexOf(el);
    if (i < 0) return null;
    return kids[i + dir] || null;
  }
  Object.defineProperty(El.prototype, 'nextElementSibling',     { get: function () { return __sib(this, 1); } });
  Object.defineProperty(El.prototype, 'previousElementSibling', { get: function () { return __sib(this, -1); } });
  // ui.js calls all of these unguarded — replaceChildren at three sites
  // including makeCardElCached's transplant, which every board and hand
  // re-render goes through; animate at 53; insertAdjacentHTML once. Missing,
  // they threw a TypeError, and where ui.js wraps FX in a bare try/catch they
  // produced silence instead: a renderer that half-ran and a green test.
  El.prototype.replaceChildren = function () {
    this.childNodes.slice().forEach(function (c) { c.parentNode = null; });
    this.childNodes.length = 0;
    this._text = '';
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      this.appendChild(typeof a === 'string' ? __textNode(a) : a);
    }
  };
  // There is no clock and no compositor here, so an animation is accepted and
  // reported finished. A suite asking whether something ANIMATED is asking a
  // browser question (see sim/gfx-budget.js).
  El.prototype.animate = function () {
    return { finished: { then: function (f) { try { f(); } catch (e) {} return this; } },
             cancel: function () {}, finish: function () {}, pause: function () {}, play: function () {} };
  };
  El.prototype.insertAdjacentHTML = function (pos, html) {
    var tmp = new El('div');
    __parseInto(tmp, String(html == null ? '' : html));
    var kids = tmp.childNodes.slice();
    if (pos === 'beforeend') kids.forEach(function (k) { this.appendChild(k); }, this);
    else if (pos === 'afterbegin') kids.reverse().forEach(function (k) { this.insertBefore(k, this.childNodes[0]); }, this);
    else if (pos === 'beforebegin' && this.parentNode) kids.forEach(function (k) { this.parentNode.insertBefore(k, this); }, this);
    else if (pos === 'afterend' && this.parentNode) kids.reverse().forEach(function (k) { this.parentNode.insertBefore(k, __sib(this, 1)); }, this);
  };
  El.prototype.insertAdjacentElement = function (pos, el) {
    if (pos === 'beforeend') return this.appendChild(el);
    if (pos === 'afterbegin') return this.insertBefore(el, this.childNodes[0]);
    if (pos === 'beforebegin' && this.parentNode) return this.parentNode.insertBefore(el, this);
    if (pos === 'afterend' && this.parentNode) return this.parentNode.insertBefore(el, __sib(this, 1));
    return el;
  };

  Object.defineProperty(El.prototype, 'firstElementChild', {
    get: function () {
      for (var i = 0; i < this.childNodes.length; i++) if (this.childNodes[i].tagName !== '#TEXT') return this.childNodes[i];
      return null;
    }
  });
  Object.defineProperty(El.prototype, 'lastElementChild', {
    get: function () {
      for (var i = this.childNodes.length - 1; i >= 0; i--) if (this.childNodes[i].tagName !== '#TEXT') return this.childNodes[i];
      return null;
    }
  });

  function __dashed(k) { return 'data-' + String(k).replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }
  function __dataset(el) {
    return new Proxy({}, {
      get: function (t, k) { return typeof k === 'string' ? el.attributes[__dashed(k)] : t[k]; },
      set: function (t, k, v) { el.attributes[__dashed(k)] = String(v); return true; },
      has: function (t, k) { return __dashed(k) in el.attributes; },
      deleteProperty: function (t, k) { delete el.attributes[__dashed(k)]; return true; },
      ownKeys: function () {
        return Object.keys(el.attributes).filter(function (a) { return a.indexOf('data-') === 0; })
          .map(function (a) { return a.slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); });
      },
      getOwnPropertyDescriptor: function (t, k) {
        var a = __dashed(k);
        return (a in el.attributes) ? { value: el.attributes[a], enumerable: true, configurable: true } : undefined;
      },
    });
  }

  function __textNode(t) { var n = new El('#text'); n._text = String(t); return n; }

  function __parseInto(parent, html) {
    var re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*(\/?)>/g;
    var stack = [parent], pos = 0, m;
    while ((m = re.exec(html))) {
      var before = html.slice(pos, m.index);
      if (before) stack[stack.length - 1].appendChild(__textNode(__unent(before)));
      pos = m.index + m[0].length;
      var close = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3] || '', self = m[4] === '/';
      if (close) { if (stack.length > 1) stack.pop(); continue; }
      var el = new El(tag);
      var are = /([a-zA-Z-]+)(?:="([^"]*)")?/g, am;
      while ((am = are.exec(attrs))) el.setAttribute(am[1], am[2] != null ? __unent(am[2]) : '');
      stack[stack.length - 1].appendChild(el);
      if (!self && !VOID[tag]) stack.push(el);
    }
    var tail = html.slice(pos);
    if (tail) stack[stack.length - 1].appendChild(__textNode(__unent(tail)));
  }
  function __unent(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  // Selector support: comma groups, descendant combinator, and per-compound
  // tag / #id / .class / [attr] / [attr="v"]. Deliberately no >, +, ~, :not or
  // pseudo-classes — a suite that needs those is asking a cascade question,
  // which belongs in a headless-Chrome fixture, not here.
  function __matchesCompound(el, c) {
    if (!c) return false;
    var re = /([#.\[]?)([^#.\[\]=]+)(?:="?([^\]"]*)"?)?\]?/g, m, ok = true;
    var parts = c.match(/(^[a-zA-Z][a-zA-Z0-9-]*)|(#[^#.\[]+)|(\.[^#.\[]+)|(\[[^\]]+\])/g) || [];
    parts.forEach(function (p) {
      if (!ok) return;
      if (p[0] === '#') ok = (el.id === p.slice(1));
      else if (p[0] === '.') ok = el.classList.contains(p.slice(1));
      else if (p[0] === '[') {
        // `indexOf('=')` landed on the `=` of `*=`, folding the operator into
        // the attribute NAME — so `[onclick*="foo"]` looked up an attribute
        // literally called `onclick*`, found null, and matched nothing. ui.js
        // uses exactly that form at two sites to find and rewire the 2v2 online
        // draft buttons, so a suite covering that area would have concluded the
        // buttons are never built. Same silent-non-match class as `:scope`.
        var inner = p.slice(1, -1);
        var am = inner.match(/^([^~^$*|=]+)(?:([~^$*|]?)=(.*))?$/);
        if (!am) { ok = false; }
        else {
          var k = am[1].trim(), op = am[2] || '', raw = am[3];
          var cur = el.getAttribute(k);
          if (raw === undefined) ok = cur != null;
          else if (cur == null) ok = false;
          else {
            var v = String(raw).replace(/^["']|["']$/g, '');
            cur = String(cur);
            ok = op === ''  ? cur === v
               : op === '*' ? cur.indexOf(v) >= 0
               : op === '^' ? cur.lastIndexOf(v, 0) === 0
               : op === '$' ? (v === '' ? false : cur.slice(-v.length) === v)
               : op === '~' ? cur.split(/\s+/).indexOf(v) >= 0
               : op === '|' ? (cur === v || cur.lastIndexOf(v + '-', 0) === 0)
               : false;
          }
        }
      } else ok = (el.tagName === p.toUpperCase());
    });
    return ok && parts.length > 0;
  }
  // A chain is [compound, combinator, compound, …]. Descendant (' ') and CHILD
  // ('>') are both supported: `:scope > .bat-lock` is written by real code in
  // this repo (UI._applyBatLock), and treating '>' as a descendant there made
  // the wrong node match — or, when the shim did not understand ':scope' at
  // all, made NOTHING match, so a removal silently did nothing and looked like
  // an engine bug. Sibling combinators and pseudo-classes are still out: those
  // are cascade questions and belong in a browser fixture.
  function __chain(one) {
    var toks = one.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      if (toks[i] === '>') { out.push({ combinator: '>' }); continue; }
      if (out.length && !out[out.length - 1].combinator) out.push({ combinator: ' ' });
      out.push({ compound: toks[i] });
    }
    return out.filter(function (t) { return t.compound || t.combinator; });
  }
  // `scopeRoot` is the element a querySelector was called ON, so `:scope` can
  // mean what it means in a browser rather than being ignored.
  function __matchesChain(el, chain, scopeRoot) {
    var parts = chain.filter(function (t) { return t.compound; });
    var combs = [];
    for (var i = 0; i < chain.length; i++) if (chain[i].combinator) combs.push(chain[i].combinator);
    var pi = parts.length - 1;
    if (!__matchesCompound2(el, parts[pi].compound, scopeRoot)) return false;
    var n = el, ci = combs.length - 1;
    pi--;
    while (pi >= 0) {
      var comb = combs[ci--] || ' ';
      if (comb === '>') {
        n = n.parentNode;
        if (!n || !__matchesCompound2(n, parts[pi].compound, scopeRoot)) return false;
      } else {
        n = n.parentNode;
        var found = false;
        while (n) { if (__matchesCompound2(n, parts[pi].compound, scopeRoot)) { found = true; break; } n = n.parentNode; }
        if (!found) return false;
      }
      pi--;
    }
    return true;
  }
  function __matchesCompound2(el, c, scopeRoot) {
    if (c === ':scope') return scopeRoot ? el === scopeRoot : false;
    return __matchesCompound(el, c);
  }
  function __matches(el, sel, scopeRoot) {
    if (!el || el.tagName === '#TEXT') return false;
    return String(sel).split(',').some(function (one) {
      var chain = __chain(one);
      if (!chain.length) return false;
      return __matchesChain(el, chain, scopeRoot);
    });
  }
  function __find(root, sel, firstOnly) {
    var out = [];
    (function walk(n) {
      for (var i = 0; i < n.childNodes.length; i++) {
        var c = n.childNodes[i];
        if (c.tagName === '#TEXT') continue;
        if (__matches(c, sel, root)) { out.push(c); if (firstOnly) return true; }
        if (walk(c)) return true;
      }
      return false;
    })(root);
    return out;
  }

  var doc = new El('#document');
  doc.documentElement = new El('html');
  doc.body = new El('body');
  doc.head = new El('head');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.appendChild(doc.documentElement);
  doc.createElement = function (t) { return new El(t); };
  doc.createElementNS = function (ns, t) { return new El(t); };
  doc.createTextNode = function (t) { return __textNode(t); };
  doc.createDocumentFragment = function () { return new El('#fragment'); };
  doc.getElementById = function (id) { return __find(doc, '#' + id, true)[0] || null; };
  doc.getElementsByClassName = function (c) { return __find(doc, '.' + c, false); };
  doc.addEventListener = function () {}; doc.removeEventListener = function () {};
  doc.hidden = false;
  doc.readyState = 'complete';
  doc.activeElement = null;

  this.document = doc;
  this.Element = El;
  this.Node = El;
  this.getComputedStyle = function (el) {
    // NO CASCADE HERE. Only inline style is visible, and a suite that asks this
    // about a stylesheet rule is asking the wrong harness — use a headless
    // Chrome fixture (see sim/gfx-budget.js and the CSS audits).
    var s = (el && el.style) || {};
    var out = { getPropertyValue: function (k) { return s[k] != null ? String(s[k]) : ''; } };
    Object.keys(s).forEach(function (k) { out[k] = s[k]; });
    return out;
  };
  this.__domEl = function (tag) { return new El(tag); };
})();

// window / storage surface ui.js touches at call time
if (typeof window === 'undefined') this.window = this;
window.document = this.document;
window.matchMedia = window.matchMedia || function () {
  return { matches: false, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} };
};
window.requestAnimationFrame = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 0); };
window.cancelAnimationFrame = window.cancelAnimationFrame || function () {};
window.getComputedStyle = this.getComputedStyle;
window.addEventListener = window.addEventListener || function () {};
window.removeEventListener = window.removeEventListener || function () {};
window.dispatchEvent = window.dispatchEvent || function () { return true; };
window.innerWidth = 1440; window.innerHeight = 900;
window.devicePixelRatio = 2;
window.scrollTo = function () {};
// CSS.escape / CSS.supports — ui.js builds attribute selectors from card names,
// several of which contain a dot or an apostrophe (Mr. Freeze, J'onn).
if (typeof CSS === 'undefined') {
  this.CSS = {
    escape: function (v) { return String(v).replace(/([^\w-])/g, '\\$1'); },
    supports: function () { return true; },
  };
  window.CSS = this.CSS;
}
if (typeof localStorage === 'undefined') {
  var __store = {};
  this.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : null; },
    setItem: function (k, v) { __store[k] = String(v); },
    removeItem: function (k) { delete __store[k]; },
    clear: function () { __store = {}; },
  };
  window.localStorage = this.localStorage;
}
// Art probing (UI.getCardArtPath -> _probeArt) constructs an Image and waits
// for onload/onerror to decide which resolution of a card's art exists. There
// is no network and no decoder here, so every probe FAILS — deliberately and
// immediately. That is the honest answer: this harness can tell you which art
// PATH a renderer asked for, never whether the file decodes. A suite that cares
// about real art files should assert against the manifest (see
// sim/art-accent.js) or use a browser.
if (typeof Image === 'undefined') {
  this.Image = function () {
    this.onload = null; this.onerror = null;
    Object.defineProperty(this, 'src', {
      // IT RECORDS THE REQUEST AND RESOLVES NOTHING. Firing onerror through
      // setTimeout looked harmless and was not: sim/shim.js runs setTimeout
      // callbacks INLINE, so `src = …` re-entered UI._probeArt's handler, which
      // schedules its own retry and then a UI.render() — also inline. Measured
      // before this: ONE UI.makeCardEl() call produced three nested UI.render()
      // calls at depth 3, with art fallbacks stamped on, so every structural
      // assertion was made against a tree that had been through three
      // re-renders. A browser does none of that: no image load or error can
      // fire during the synchronous body of makeCardEl.
      //
      // So the faithful behaviour is to stay pending. A suite that needs a
      // probe outcome should set UI._artProbe directly and say so.
      set: function (v) { this._src = v; },
      get: function () { return this._src; }
    });
  };
  window.Image = this.Image;
}
if (typeof navigator === 'undefined') this.navigator = { userAgent: 'jsc-headless', hardwareConcurrency: 8, maxTouchPoints: 0 };
if (typeof performance === 'undefined') this.performance = { now: function () { return 0; } };

// ---- THE REAL APP SHELL ------------------------------------------------
// UI.init() caches ~60 elements by id (this.draftEl = getElementById(
// 'draft-overlay'), and so on), and every renderer assumes they are there. A
// harness that hands back an empty document makes each of those undefined, so
// the first render dies on a null deref that cannot happen in a browser — a
// harness artefact masquerading as a bug.
//
// So the shell is built from index.html itself rather than from a hand-written
// list that would drift the first time an element was renamed. Scripts, styles
// and comments are dropped; what is left is the element tree the page actually
// ships, with its ids and classes.
(function () {
  var html;
  try { html = read('index.html'); } catch (e) { return; }
  html = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  var m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  document.body.innerHTML = m ? m[1] : html;
})();

// THE REAL ui.js. Its auto-start is skipped under __HEADLESS_SIM (see the tail
// of that file), so loading it defines UI without going at a browser.
load('./ui.js');

// …and then the element cache it would have built. init() also wires listeners,
// starts timers and kicks the menu, none of which belong in a harness — this is
// only the id lookups, so renderers find what they expect.
(function () {
  if (!UI || typeof UI !== 'object') return;
  var src = read('ui.js');
  var re = /this\.([a-zA-Z_$][\w$]*)\s*=\s*document\.getElementById\('([^']+)'\)/g, m;
  var n = 0;
  while ((m = re.exec(src))) {
    if (UI[m[1]] == null) { UI[m[1]] = document.getElementById(m[2]); n++; }
  }
  this.__uiCachedEls = n;
})();
