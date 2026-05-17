// Stats collector — JSC-compatible. Exposes SimStats global.
//
// Collects the same per-card fields the browser's finalizeStats writes to
// localStorage, so the `sim/data/cards.json` report can drive the "Sim"
// tab in the stats dashboard AND stand alone for balance analysis.
//
// Weights MUST match ui.js#_IMPACT_WEIGHTS and game.js#finalizeStats so
// MVP attribution + Impact Index + Contribution are computed identically
// across browser play and simulation runs.

var SimStats = (function () {

  // Weighted-impact components — v6. Adds killValue for destroy credit.
  // MUST match game.js (Game.finalizeStats WEIGHTS, ~line 405). The
  // sim and the in-game recap previously had different formulas under
  // the same name, so a card's "Impact Index" in a 20K-sim report
  // disagreed with what its real game recap would show. Unified here
  // so both surfaces speak the same sabermetric language.
  //
  // Card-advantage is special: in-game, it's `draws × _avgCardImpact ×
  // 0.85` — a per-game runtime multiplier we can't compute here without
  // first-passing all cards. We approximate with a flat `cardAdvantage:
  // 4.25` (≈ avgCardImpact 5.0 × 0.85), which lands in the typical
  // observed range. Exact sabermetric parity isn't required — what
  // matters is the relative ranking among cards, which the linear
  // weights preserve.
  var W = {
    faceDamage:   1.2,
    boardDamage:  0.4,   // dropped 0.6 → 0.4 to match v7.1 (audit)
    energy:       2.0,
    discount:     1.5,
    damageDenied: 0.9,
    debuff:       0.7,
    heal:         1.0,
    killTempo:    1.0,
    cardAdvantage: 4.25  // approximation of avgCardImpact × 0.85
  };
  function weighted(c) {
    return W.faceDamage    * (c.statsHealthbarDamage || 0) +
           W.boardDamage   * (c.statsEnemyDamage     || 0) +
           W.damageDenied  * (c.statsDamageAbsorbed  || 0) +
           W.energy        * (c.statsEnergyGenerated || 0) +
           W.cardAdvantage * (c.statsCardAdvantage   || 0) +
           W.killTempo     * (c.statsKillTempo       || c.statsKillValue || 0) +
           W.heal          * (c.statsHealLeveraged   || c.statsHealingDone || 0) +
           W.discount      * (c.statsDiscountValue   || 0) +
           W.debuff        * (c.statsDebuffValue     || 0);
  }

  function createCollector() {
    var cards = Object.create(null);   // name -> { drafts, wins, plays, kills, deaths, ... }
    var tricks = Object.create(null);
    var globals = { games: 0, playerWins: 0, aiWins: 0, draws: 0, totalRounds: 0 };
    var gameCtx = null;

    function bumpCard(name, key, amt) {
      var e = cards[name] || (cards[name] = {
        drafts: 0, draftsInWin: 0, gamesInDeck: 0, gamesInDeckInWin: 0,
        gamesPlayed: 0,
        plays: 0, deaths: 0,
        hpDamage: 0, cardDamage: 0, absorbed: 0, energyGen: 0, cardAdvantage: 0,
        // v3 captures
        healing: 0, discount: 0, debuff: 0,
        // v6: killValue — weighted credit for destroy effects
        killValue: 0,
        mvp: 0, contributionSum: 0, contributionN: 0,
        kills: 0, freezesApplied: 0, stunsApplied: 0, fearsApplied: 0, mcApplied: 0,
        weightedImpactSum: 0
      });
      e[key] = (e[key] || 0) + (amt || 0);
    }
    function bumpTrick(name, key, amt) {
      var e = tricks[name] || (tricks[name] = { drafts: 0, draftsInWin: 0, casts: 0 });
      e[key] = (e[key] || 0) + (amt || 1);
    }

    return {
      cards: cards, tricks: tricks, globals: globals,

      onGameStart: function (state) {
        gameCtx = {
          playerDrafts: [], aiDrafts: [],
          playerTrickDrafts: [], aiTrickDrafts: []
        };
      },

      onDraftComplete: function (state) {
        // Deckbuilder has no draft — onDraftComplete still runs but
        // state.draft is null. Pull deck names from the per-player draw
        // piles instead (both were built in game.js#buildDecks).
        if (state.draft) {
          gameCtx.playerDrafts = state.draft.playerDrafted.map(function (c) { return c.name; });
          gameCtx.aiDrafts     = state.draft.aiDrafted.map(function (c) { return c.name; });
          gameCtx.playerTrickDrafts = state.draft.playerTrickDrafted.map(function (c) { return c.name; });
          gameCtx.aiTrickDrafts     = state.draft.aiTrickDrafted.map(function (c) { return c.name; });
        } else if (state.mode && state.mode.deck === 'deckbuilder') {
          // The deckbuilder puts the full deck into state[side].drawPile
          // BEFORE dealing the opening hand — but dealDeckbuilderOpeningHands
          // has already run by the time onDraftComplete fires, so add the
          // opening hand + played + dead instances back in to recover the
          // full original deck list.
          ['player', 'ai'].forEach(function (side) {
            var key = side + 'Drafts';
            var trickKey = side + 'TrickDrafts';
            var drafts = state[side].drawPile.map(function (c) { return c.name; });
            state[side].hand.forEach(function (c) { drafts.push(c.name); });
            // Board + deadPile may not exist yet at draft-complete time; skip.
            gameCtx[key] = drafts;
            var trickDrafts = state[side].trickDrawPile.map(function (t) { return t.name; });
            state[side].trickHand.forEach(function (t) { trickDrafts.push(t.name); });
            gameCtx[trickKey] = trickDrafts;
          });
        }
        gameCtx.playerDrafts.forEach(function (n) { bumpCard(n, 'drafts', 1); });
        gameCtx.aiDrafts.forEach(function (n) { bumpCard(n, 'drafts', 1); });
        gameCtx.playerTrickDrafts.forEach(function (n) { bumpTrick(n, 'drafts', 1); });
        gameCtx.aiTrickDrafts.forEach(function (n) { bumpTrick(n, 'drafts', 1); });
        // gamesInDeck — once per UNIQUE name per side, regardless of copies.
        function bumpUnique(names, side) {
          var seen = {};
          for (var i = 0; i < names.length; i++) {
            if (seen[names[i]]) continue;
            seen[names[i]] = true;
            bumpCard(names[i], 'gamesInDeck', 1);
          }
        }
        bumpUnique(gameCtx.playerDrafts, 'player');
        bumpUnique(gameCtx.aiDrafts, 'ai');
      },

      onGameEnd: function (state) {
        globals.games++;
        globals.totalRounds += state.round;
        if (state.winner === 'player') globals.playerWins++;
        else if (state.winner === 'ai') globals.aiWins++;
        else globals.draws++;

        function tally(drafts, side, won) {
          for (var i = 0; i < drafts.length; i++) {
            var n = drafts[i];
            if (won) bumpCard(n, 'draftsInWin', 1);
          }
          // Unique-win credit for gamesInDeck denominator of win rate.
          if (won) {
            var seen = {};
            for (var j = 0; j < drafts.length; j++) {
              if (seen[drafts[j]]) continue;
              seen[drafts[j]] = true;
              bumpCard(drafts[j], 'gamesInDeckInWin', 1);
            }
          }
        }
        tally(gameCtx.playerDrafts, 'player', state.winner === 'player');
        tally(gameCtx.aiDrafts, 'ai', state.winner === 'ai');

        ['player', 'ai'].forEach(function (side) {
          var won = state.winner === side;
          var played = state[side].playedTrickPile.map(function (t) { return t.name; });
          var drafted = side === 'player' ? gameCtx.playerTrickDrafts : gameCtx.aiTrickDrafts;
          played.forEach(function (n) { bumpTrick(n, 'casts', 1); });
          if (won) drafted.forEach(function (n) { bumpTrick(n, 'draftsInWin', 1); });
        });

        // (Legacy dead-pile death count removed — the per-instance pass
        // below already bumps `deaths` for instances with HP<=0 or
        // _deathHandled, which covers every card in deadPile.)

        // Per-side MVP + impact aggregation. Same formula as game.js
        // and ui.js so all three agree on what "impact" means.
        //
        // `gamesPlayed` is bumped ONCE PER UNIQUE NAME PER GAME
        // (across both sides) — this is the denominator for MVP Rate.
        //
        // Token instances (Undead Warrior, Doombot, Ant, Null, Parademon,
        // Loki Clone, The Kraken, etc.) are SKIPPED because:
        //   1. they aren't draftable — nobody can pick them
        //   2. their stats are already credited up-chain to the summoner
        //      via _creditChain (so counting them again double-attributes)
        // Real-card instances summoned by TRICKS (Bat Signal pulling in
        // an Ant-Man, Super Soldier Serum transforming into Thanos, etc.)
        // DO count — the trick brought a real card onto the board and
        // that card's performance is what we want to measure.
        //
        // Detector: any name not in CARD_DEFS is a token. Built once per
        // onGameEnd since CARD_DEFS doesn't change during a run.
        var validCardNames = {};
        if (typeof CARD_DEFS !== 'undefined') {
          for (var vi = 0; vi < CARD_DEFS.length; vi++) validCardNames[CARD_DEFS[vi].name] = true;
        }
        var isRealCard = function (c) { return c && validCardNames[c.name]; };

        var appearedThisGame = {};
        ['player', 'ai'].forEach(function (side) {
          var won = state.winner === side;
          var instances = [];
          for (var i = 0; i < state.lanes.length; i++) {
            var c = state.lanes[i][side];
            if (isRealCard(c)) instances.push(c);
          }
          // DeadPile entries are SHADOWS (not live instances) and don't
          // have `currentHealth`/`_deathHandled` set. Tag each so the
          // death-count bump below fires correctly — otherwise cards with
          // 0 deaths got reported as never dying even when they died in
          // every single game (Dr. Manhattan, Galactus, etc.).
          (state[side].deadPile || []).forEach(function (c) {
            if (isRealCard(c)) {
              c._deathHandled = true;
              instances.push(c);
            }
          });
          // Discard-effect cards live in their own pile. discardPile
          // stores SHADOW objects (see game.js#playCard discard branch);
          // use `_sourceInstance` to recover the live card with its
          // real stats fields (statsDiscountValue, statsHealingDone, etc.).
          (state[side].discardPile || []).forEach(function (c) {
            var live = c._sourceInstance || c;
            if (isRealCard(live)) instances.push(live);
          });
          var sideTotal = 0, topImpact = -1, top = null;
          instances.forEach(function (c) {
            var w = weighted(c);
            sideTotal += w;
            if (w > topImpact) { topImpact = w; top = c; }
          });
          instances.forEach(function (c) {
            // plays = # of instances that reached the board. Instance-based
            // so a card summoned / foresee'd in without being drafted still
            // gets counted. Previously the drafts-tally was the only source
            // of plays, which under-counted non-drafted appearances.
            bumpCard(c.name, 'plays', 1);
            if (c.currentHealth <= 0 || c._deathHandled) bumpCard(c.name, 'deaths', 1);
            bumpCard(c.name, 'hpDamage',       c.statsHealthbarDamage || 0);
            bumpCard(c.name, 'cardDamage',     c.statsEnemyDamage     || 0);
            bumpCard(c.name, 'absorbed',       c.statsDamageAbsorbed  || 0);
            bumpCard(c.name, 'energyGen',      c.statsEnergyGenerated || 0);
            bumpCard(c.name, 'cardAdvantage',  c.statsCardAdvantage   || 0);
            bumpCard(c.name, 'killValue',      c.statsKillValue       || 0);
            bumpCard(c.name, 'kills',          c.statsKills           || 0);
            bumpCard(c.name, 'freezesApplied', c.statsFreezesApplied  || 0);
            bumpCard(c.name, 'stunsApplied',   c.statsStunsApplied    || 0);
            bumpCard(c.name, 'fearsApplied',   c.statsFearsApplied    || 0);
            bumpCard(c.name, 'mcApplied',      c.statsMcApplied       || 0);
            // v3 captures
            bumpCard(c.name, 'healing',        c.statsHealingDone     || 0);
            bumpCard(c.name, 'discount',       c.statsDiscountValue   || 0);
            bumpCard(c.name, 'debuff',         c.statsDebuffValue     || 0);
            bumpCard(c.name, 'weightedImpactSum', weighted(c));
            if (sideTotal > 0) {
              bumpCard(c.name, 'contributionSum', weighted(c) / sideTotal);
              bumpCard(c.name, 'contributionN', 1);
            }
            // gamesPlayed — once per card name per game (not per instance,
            // not per side). First appearance in this game flips the flag.
            if (!appearedThisGame[c.name]) {
              appearedThisGame[c.name] = true;
              bumpCard(c.name, 'gamesPlayed', 1);
            }
          });
          if (won && top) bumpCard(top.name, 'mvp', 1);
        });

        // plays counter from tally() double-counts with the per-instance
        // bump above; we overwrite the per-instance count to the tally
        // value (which matches the browser semantics of "drawn, not
        // sitting in hand"). Net: subtract the instance-pass plays.
        // Actually simpler — let plays mean "instances that played", so
        // re-zero the tally-version here:
        // (intentionally left as-is; the reporter uses playRate which
        // divides by drafts, consistent with either definition.)
      },
    };
  }

  // Wilson score at 95%.
  function wilson(wins, n) {
    if (n === 0) return [0, 0];
    var z = 1.96;
    var p = wins / n;
    var denom = 1 + (z * z) / n;
    var centre = p + (z * z) / (2 * n);
    var margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
  }

  // Per-cost baseline — each cost has its own bucket so a 4-cost card
  // is compared only to other 4-cost cards, not 4-6 lumped together.
  // Keep in sync with ui.js#_costBucket.
  function costBucket(cost) {
    return String(cost);
  }

  function finalize(collect) {
    // Pass 1: build raw rows + derived per-card values.
    var cardRows = [];
    var defs = (typeof CARD_DEFS !== 'undefined') ? CARD_DEFS : [];
    function costOf(name) {
      for (var i = 0; i < defs.length; i++) if (defs[i].name === name) return defs[i].cost || 0;
      return 0;
    }
    for (var name in collect.cards) {
      var e = collect.cards[name];
      var wr = e.drafts > 0 ? e.draftsInWin / e.drafts : 0;
      var ci = wilson(e.draftsInWin || 0, e.drafts || 0);
      var cost = costOf(name);
      var bucket = costBucket(cost);
      var plays = e.plays || 0;
      var gamesInDeck = e.gamesInDeck || 0;
      var gamesPlayed = e.gamesPlayed || 0;
      var weightedPerPlay = plays > 0 ? (e.weightedImpactSum || 0) / plays : 0;
      var contribution = e.contributionN > 0 ? e.contributionSum / e.contributionN : 0;
      // MVP rate — "when this card appears on the board, how often is it
      // the top-impact card on the winning side?" Using gamesPlayed (not
      // gamesInDeck) because some cards reach the board via non-draft
      // paths (Dr. Strange foresee, Bat Signal / Mother Box, Super
      // Soldier Serum transforms, Hela resurrections, etc.). Without
      // gamesPlayed the denominator can be smaller than the numerator.
      var mvpRate = gamesPlayed > 0 ? (e.mvp || 0) / gamesPlayed : 0;
      cardRows.push({
        name: name, cost: cost, bucket: bucket,
        drafts: e.drafts || 0, draftsInWin: e.draftsInWin || 0,
        gamesInDeck: gamesInDeck, gamesInDeckInWin: e.gamesInDeckInWin || 0,
        gamesPlayed: gamesPlayed,
        winRate: wr, ci95: ci,
        plays: plays, deaths: e.deaths || 0,
        playRate: e.drafts > 0 ? plays / e.drafts : 0,
        deathRate: plays > 0 ? (e.deaths || 0) / plays : 0,
        hpDamage: e.hpDamage || 0,
        cardDamage: e.cardDamage || 0,
        absorbed: e.absorbed || 0,
        energyGen: e.energyGen || 0,
        cardAdvantage: e.cardAdvantage || 0,
        // v3 components
        healing: e.healing || 0,
        discount: e.discount || 0,
        debuff: e.debuff || 0,
        // v6 component — destroy credit
        killValue: e.killValue || 0,
        kills: e.kills || 0,
        freezesApplied: e.freezesApplied || 0,
        stunsApplied: e.stunsApplied || 0,
        fearsApplied: e.fearsApplied || 0,
        mcApplied: e.mcApplied || 0,
        weightedImpactSum: e.weightedImpactSum || 0,
        weightedPerPlay: weightedPerPlay,
        contribution: contribution,
        mvp: e.mvp || 0,
        mvpRate: mvpRate,
      });
    }
    // Pass 2: per-cost MEDIAN baseline → Impact Index per card.
    // Median (not mean) so a couple of dominant cards in a small cost
    // bucket (Knull / Dr. Manhattan at cost 10) don't drag the
    // baseline up and squash their peers. Each card contributes its
    // weightedPerPlay once; we take the middle value of that list.
    var bucketBuckets = {};
    cardRows.forEach(function (r) {
      if (r.plays <= 0) return;
      (bucketBuckets[r.bucket] = bucketBuckets[r.bucket] || []).push(r.weightedPerPlay);
    });
    var medians = {};
    Object.keys(bucketBuckets).forEach(function (b) {
      var arr = bucketBuckets[b].slice().sort(function (a, c) { return a - c; });
      var n = arr.length;
      medians[b] = n ? (n % 2 === 0 ? (arr[n/2-1] + arr[n/2]) / 2 : arr[(n-1)/2]) : 0;
    });
    cardRows.forEach(function (r) {
      var baseline = medians[r.bucket] || 0;
      r.bucketAvg = baseline; // kept as `bucketAvg` name for backwards compat with UI
      r.impactIndex = baseline > 0 ? r.weightedPerPlay / baseline : null;
    });
    // Pass 3: MVP+ — Mike Trout efficiency metric. impact-per-cost for
    // each card, normalized to 100 = league-average impact-per-cost.
    // 200 = double-efficient ("bomb"), 50 = half-efficient ("filler").
    // Mirrors Game.finalizeStats's per-game MVP+ calculation but
    // aggregated across all games. League average is the MEAN of every
    // card's per-cost rate (not per-cost-bucket — we want a single
    // benchmark across all cost tiers, since efficiency should be
    // comparable across the curve). 0-cost cards excluded (would
    // divide by zero).
    var rates = [];
    cardRows.forEach(function (r) {
      if (r.plays <= 0 || r.cost <= 0) return;
      rates.push(r.weightedPerPlay / r.cost);
    });
    var leagueAvgRate = 0;
    if (rates.length) {
      var sum = 0;
      for (var i = 0; i < rates.length; i++) sum += rates[i];
      leagueAvgRate = sum / rates.length;
    }
    cardRows.forEach(function (r) {
      if (r.plays <= 0 || r.cost <= 0 || leagueAvgRate <= 0) {
        r.mvpPlus = null;
        return;
      }
      r.mvpPlus = Math.round((r.weightedPerPlay / r.cost) / leagueAvgRate * 100);
    });
    cardRows.sort(function (a, b) { return b.winRate - a.winRate; });

    var trickRows = [];
    for (var tname in collect.tricks) {
      var te = collect.tricks[tname];
      var twr = te.drafts > 0 ? te.draftsInWin / te.drafts : 0;
      var tci = wilson(te.draftsInWin || 0, te.drafts || 0);
      trickRows.push({
        name: tname, drafts: te.drafts || 0, draftsInWin: te.draftsInWin || 0,
        winRate: twr, ci95: tci,
        casts: te.casts || 0,
        castRate: te.drafts > 0 ? (te.casts || 0) / te.drafts : 0,
      });
    }
    trickRows.sort(function (a, b) { return b.winRate - a.winRate; });

    return {
      summary: {
        games: collect.globals.games,
        playerWins: collect.globals.playerWins,
        aiWins: collect.globals.aiWins,
        draws: collect.globals.draws,
        avgRounds: collect.globals.games ? collect.globals.totalRounds / collect.globals.games : 0,
      },
      cards: cardRows,
      tricks: trickRows,
    };
  }

  function renderMarkdown(out) {
    var md = [];
    md.push('# Simulation Report');
    md.push('');
    md.push('Games: ' + out.summary.games + ' | Player wins: ' + out.summary.playerWins + ' | AI wins: ' + out.summary.aiWins + ' | Draws: ' + out.summary.draws + ' | Avg rounds: ' + out.summary.avgRounds.toFixed(2));
    md.push('');
    md.push('## Cards — ranked by win rate (min 30 drafts)');
    md.push('');
    md.push('| Card | Cost | Drafts | WR | 95% CI | Plays | PlayR | Deaths | ImpactIdx | MVP+ | Contrib | MVP% | Damage | Absorbed | EnergyGen | Kills | Frz | Stun | Fear | MC |');
    md.push('|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    out.cards.filter(function (c) { return c.drafts >= 30; }).forEach(function (c) {
      var idxStr = c.impactIndex == null ? '—' : c.impactIndex.toFixed(2) + '×';
      var mvpPlusStr = c.mvpPlus == null ? '—' : String(c.mvpPlus);
      var damage = (c.hpDamage || 0) + (c.cardDamage || 0);
      md.push('| ' + c.name +
        ' | ' + c.cost +
        ' | ' + c.drafts +
        ' | ' + (c.winRate * 100).toFixed(1) + '% | ' +
        (c.ci95[0] * 100).toFixed(1) + '–' + (c.ci95[1] * 100).toFixed(1) + '% | ' +
        c.plays + ' | ' + (c.playRate * 100).toFixed(0) + '% | ' + c.deaths +
        ' | ' + idxStr +
        ' | ' + mvpPlusStr +
        ' | ' + (c.contribution * 100).toFixed(1) + '%' +
        ' | ' + (c.mvpRate * 100).toFixed(1) + '%' +
        ' | ' + damage +
        ' | ' + c.absorbed +
        ' | ' + c.energyGen +
        ' | ' + c.kills +
        ' | ' + c.freezesApplied +
        ' | ' + c.stunsApplied +
        ' | ' + c.fearsApplied +
        ' | ' + c.mcApplied +
        ' |');
    });
    md.push('');
    md.push('## Tricks — ranked by win rate (min 30 drafts)');
    md.push('');
    md.push('| Trick | Drafts | Wins | WR | 95% CI | Casts |');
    md.push('|---|---:|---:|---:|---|---:|');
    out.tricks.filter(function (t) { return t.drafts >= 30; }).forEach(function (t) {
      md.push('| ' + t.name + ' | ' + t.drafts + ' | ' + t.draftsInWin + ' | ' + (t.winRate * 100).toFixed(1) + '% | ' +
        (t.ci95[0] * 100).toFixed(1) + '–' + (t.ci95[1] * 100).toFixed(1) + '% | ' + t.casts + ' |');
    });
    md.push('');
    md.push('## Balance flags — CI outside 45–55% (min 30 drafts)');
    md.push('');
    var over = out.cards.filter(function (c) { return c.drafts >= 30 && c.ci95[0] > 0.55; })
      .sort(function (a, b) { return b.winRate - a.winRate; })
      .map(function (c) { return '▲ ' + c.name + ' (' + (c.winRate * 100).toFixed(1) + '% WR, idx ' + (c.impactIndex == null ? '—' : c.impactIndex.toFixed(2) + '×') + ')'; });
    var under = out.cards.filter(function (c) { return c.drafts >= 30 && c.ci95[1] < 0.45; })
      .sort(function (a, b) { return a.winRate - b.winRate; })
      .map(function (c) { return '▼ ' + c.name + ' (' + (c.winRate * 100).toFixed(1) + '% WR, idx ' + (c.impactIndex == null ? '—' : c.impactIndex.toFixed(2) + '×') + ')'; });
    md.push('**Overperformers:** ' + (over.length ? over.join(', ') : '_none_'));
    md.push('');
    md.push('**Underperformers:** ' + (under.length ? under.join(', ') : '_none_'));
    md.push('');
    md.push('## Cards with < 30 drafts (sample too small)');
    md.push('');
    var tail = out.cards.filter(function (c) { return c.drafts < 30; })
      .map(function (c) { return c.name + ' (' + c.drafts + ')'; }).join(', ');
    md.push(tail || '_none_');
    md.push('');
    return md.join('\n');
  }

  function writeReports(out, dir) {
    writeFile(dir + '/cards.json', JSON.stringify(out.cards, null, 2));
    writeFile(dir + '/tricks.json', JSON.stringify(out.tricks, null, 2));
    writeFile(dir + '/summary.json', JSON.stringify(out.summary, null, 2));
    writeFile(dir + '/report.md', renderMarkdown(out));
    appendHistory(out, dir);
  }

  // Append a compact snapshot of this run to history.json. UI reads this
  // to render a "recent sim runs" trend view. Keep the last 20 entries —
  // more than enough to see balance-change effects, and keeps the file
  // small (each entry is ~10KB).
  function appendHistory(out, dir) {
    var HIST_LIMIT = 20;
    var path = dir + '/history.json';
    var history = { runs: [] };
    try {
      var raw = read(path);
      if (raw) history = JSON.parse(raw) || { runs: [] };
      if (!Array.isArray(history.runs)) history.runs = [];
    } catch (e) { /* file doesn't exist — start fresh */ }

    // Minimal snapshot — card/trick WR + drafts only (no full damage stats).
    // Keeps the file ~95% smaller than the full report.
    var cardSnap = {};
    for (var i = 0; i < out.cards.length; i++) {
      var c = out.cards[i];
      cardSnap[c.name] = { wr: c.winRate, drafts: c.drafts };
    }
    var trickSnap = {};
    for (var j = 0; j < out.tricks.length; j++) {
      var t = out.tricks[j];
      trickSnap[t.name] = { wr: t.winRate, drafts: t.drafts };
    }

    history.runs.unshift({
      timestamp: new Date().toISOString(),
      games: out.summary.games,
      playerWins: out.summary.playerWins,
      aiWins: out.summary.aiWins,
      draws: out.summary.draws,
      avgRounds: out.summary.avgRounds,
      cards: cardSnap,
      tricks: trickSnap,
    });
    if (history.runs.length > HIST_LIMIT) history.runs.length = HIST_LIMIT;
    writeFile(path, JSON.stringify(history, null, 2));
  }

  return { createCollector: createCollector, finalize: finalize, writeReports: writeReports, wilson: wilson };
})();
