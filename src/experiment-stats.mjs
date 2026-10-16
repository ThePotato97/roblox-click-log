// Statistical summaries for compare= reads. All resampling happens at player
// level, so a player with many sessions or purchases is still sampled once.

const Z95 = 1.959963984540054;

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const quantile = (values, p) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * p;
    const lo = Math.floor(index);
    const hi = Math.ceil(index);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
};

export function wilson(successes, n) {
    if (!n) return [null, null];
    const p = successes / n;
    const z2 = Z95 * Z95;
    const scale = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / scale;
    const half = Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / scale;
    return [Math.max(0, center - half), Math.min(1, center + half)];
}

const hash = (text) => {
    let value = 2166136261;
    for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
    return value >>> 0;
};

const random = (seed) => {
    let value = seed || 1;
    return () => {
        value += 0x6D2B79F5;
        let next = value;
        next = Math.imul(next ^ next >>> 15, next | 1);
        next ^= next + Math.imul(next ^ next >>> 7, next | 61);
        return ((next ^ next >>> 14) >>> 0) / 4294967296;
    };
};

const round = (value) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(6));
const percentileBounds = (samples) => samples.length
    ? [quantile(samples, 0.025), quantile(samples, 0.975)] : [null, null];

function valuesFor(players) {
    const prompted = players.filter((player) => player.prompted);
    const eligible = players.filter((player) => player.d1Eligible);
    const sessions = players.flatMap((player) => player.sessions.map((session) => session.duration));
    return {
        players: players.length,
        conversion: players.length ? players.filter((player) => player.buyer).length / players.length : 0,
        promptedConversion: prompted.length ? prompted.filter((player) => player.buyer).length / prompted.length : 0,
        spendPerPlayer: mean(players.map((player) => player.spend)),
        sessionMedian: quantile(sessions, 0.5),
        sessionMean: mean(sessions),
        sessionP90: quantile(sessions, 0.9),
        d1Return: eligible.length ? eligible.filter((player) => player.d1).length / eligible.length : 0,
    };
}

function samplesFor(players, iterations, seed) {
    const rng = random(hash(seed));
    const samples = Object.fromEntries([
        'conversion', 'promptedConversion', 'spendPerPlayer', 'sessionMedian', 'sessionMean', 'sessionP90', 'd1Return',
    ].map((key) => [key, []]));
    if (!players.length) return samples;
    for (let iteration = 0; iteration < iterations; iteration++) {
        const picked = [];
        for (let i = 0; i < players.length; i++) picked.push(players[Math.floor(rng() * players.length)]);
        const values = valuesFor(picked);
        for (const key of Object.keys(samples)) samples[key].push(values[key]);
    }
    return samples;
}

const metric = (value, lower, upper, n, method) => ({
    value: round(value), lower: round(lower), upper: round(upper), n, method,
    liftVsControl: null, chanceBeatsControl: null,
});

function baseMetrics(players, samples, includeIntervals) {
    const values = valuesFor(players);
    const prompted = players.filter((player) => player.prompted);
    const eligible = players.filter((player) => player.d1Eligible);
    const sessions = players.flatMap((player) => player.sessions.map((session) => session.duration));
    const buyers = players.filter((player) => player.buyer).length;
    const promptedBuyers = prompted.filter((player) => player.buyer).length;
    const returns = eligible.filter((player) => player.d1).length;
    const [conversionLo, conversionHi] = includeIntervals ? wilson(buyers, players.length) : [null, null];
    const [promptedLo, promptedHi] = includeIntervals ? wilson(promptedBuyers, prompted.length) : [null, null];
    const [d1Lo, d1Hi] = includeIntervals ? wilson(returns, eligible.length) : [null, null];
    const continuous = (key, n) => {
        const [lo, hi] = percentileBounds(samples[key]);
        return metric(values[key], lo, hi, n, 'bootstrap');
    };
    return {
        players: metric(players.length, null, null, players.length, 'none'),
        conversion: metric(values.conversion, conversionLo, conversionHi, players.length, 'wilson'),
        promptedConversion: metric(values.promptedConversion, promptedLo, promptedHi, prompted.length, 'wilson'),
        spendPerPlayer: continuous('spendPerPlayer', players.length),
        sessionMedian: continuous('sessionMedian', sessions.length),
        sessionMean: continuous('sessionMean', sessions.length),
        sessionP90: continuous('sessionP90', sessions.length),
        d1Return: metric(values.d1Return, d1Lo, d1Hi, eligible.length, 'wilson'),
    };
}

function attachControl(metricsByArm, samplesByArm, control) {
    const controlMetrics = metricsByArm[control];
    if (!controlMetrics) throw Object.assign(new Error(`control arm ${control} was not found`), { status: 400 });
    for (const [arm, metrics] of Object.entries(metricsByArm)) {
        for (const [key, current] of Object.entries(metrics)) {
            const baseline = controlMetrics[key];
            if (!baseline || key === 'players') continue;
            if (arm === control) {
                current.liftVsControl = { value: 0, lower: 0, upper: 0 };
                current.chanceBeatsControl = 0.5;
                continue;
            }
            const value = baseline.value ? current.value / baseline.value - 1 : null;
            const armSamples = samplesByArm[arm]?.[key] ?? [];
            const controlSamples = samplesByArm[control]?.[key] ?? [];
            const lifts = [];
            let wins = 0;
            const length = Math.min(armSamples.length, controlSamples.length);
            for (let i = 0; i < length; i++) {
                if (armSamples[i] > controlSamples[i]) wins++;
                else if (armSamples[i] === controlSamples[i]) wins += 0.5;
                if (controlSamples[i]) lifts.push(armSamples[i] / controlSamples[i] - 1);
            }
            const [lower, upper] = percentileBounds(lifts);
            current.liftVsControl = { value: round(value), lower: round(lower), upper: round(upper) };
            current.chanceBeatsControl = length ? round(wins / length) : null;
        }
    }
}

function distributions(players) {
    const spend = [
        ['0', (value) => value === 0],
        ['1-50', (value) => value >= 1 && value <= 50],
        ['51-200', (value) => value > 50 && value <= 200],
        ['200+', (value) => value > 200],
    ].map(([bucket, includes]) => ({
        bucket,
        players: players.filter((player) => includes(player.spend)).length,
    }));
    const purchases = [
        ['0', (value) => value === 0],
        ['1', (value) => value === 1],
        ['2', (value) => value === 2],
        ['3+', (value) => value >= 3],
    ].map(([bucket, includes]) => ({
        bucket,
        players: players.filter((player) => includes(player.purchases)).length,
    }));
    const playerSpend = players.map((player) => player.spend).sort((a, b) => b - a);
    const totalSpend = playerSpend.reduce((sum, value) => sum + value, 0);
    const topCount = playerSpend.length ? Math.max(1, Math.ceil(playerSpend.length * 0.01)) : 0;
    const topSpend = playerSpend.slice(0, topCount).reduce((sum, value) => sum + value, 0);
    const sessions = players.flatMap((player) => player.sessions.map((session) => session.duration));
    return {
        spend: {
            buckets: spend.map((row) => ({ ...row, share: players.length ? round(row.players / players.length) : 0 })),
            p50: round(quantile(players.map((player) => player.spend), 0.5)),
            p90: round(quantile(players.map((player) => player.spend), 0.9)),
            p99: round(quantile(players.map((player) => player.spend), 0.99)),
            top1Share: totalSpend ? round(topSpend / totalSpend) : 0,
        },
        session: {
            histogram: sessionHistogram(sessions),
            mean: round(mean(sessions)), p50: round(quantile(sessions, 0.5)), p90: round(quantile(sessions, 0.9)),
        },
        purchases: {
            buckets: purchases.map((row) => ({ ...row, share: players.length ? round(row.players / players.length) : 0 })),
            repeatBuyers: players.filter((player) => player.purchases >= 2).length,
        },
    };
}

function sessionHistogram(values) {
    const buckets = [
        ['<1m', 0, 60], ['1-3m', 60, 180], ['3-10m', 180, 600], ['10-30m', 600, 1800], ['30m+', 1800, Infinity],
    ];
    return buckets.map(([bucket, lo, hi]) => {
        const sessions = values.filter((value) => value >= lo && value < hi).length;
        return { bucket, sessions, share: values.length ? round(sessions / values.length) : 0 };
    });
}

function atCutoff(player, cutoff, dataCutoff) {
    if (player.firstExposure > cutoff) return null;
    const sessions = player.sessions.filter((session) => session.at <= cutoff);
    const buys = player.buys.filter((buy) => buy.at <= cutoff);
    const prompts = player.prompts.filter((at) => at <= cutoff);
    const spend = buys.reduce((sum, buy) => sum + buy.price, 0);
    const d1Eligible = player.firstExposure + 2 * 86400 <= Math.min(cutoff, dataCutoff);
    return {
        ...player, sessions, spend, purchases: buys.length, buyer: buys.length > 0,
        prompted: prompts.length > 0, d1Eligible,
    };
}

export function summarizeExperiment(records, {
    control = null, ci = false, dist = null, cutoffs = [], dataCutoff, seed = '', iterations = 300,
} = {}) {
    const grouped = new Map();
    for (const record of records) {
        if (!grouped.has(record.arm)) grouped.set(record.arm, []);
        grouped.get(record.arm).push(record);
    }
    const samplesByArm = {};
    const metricsByArm = {};
    const arms = [];
    for (const [arm, players] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
        const samples = samplesFor(players, ci ? iterations : 0, `${seed}:${arm}:final`);
        samplesByArm[arm] = samples;
        metricsByArm[arm] = baseMetrics(players, samples, ci);
        arms.push({ arm, metrics: metricsByArm[arm], distributions: distributions(players) });
    }
    if (control !== null) attachControl(metricsByArm, samplesByArm, control);

    const series = cutoffs.map((cutoff) => {
        const point = { at: new Date(cutoff * 1000).toISOString(), arms: [] };
        const pointMetrics = {};
        const pointSamples = {};
        for (const [arm, players] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
            const snapshot = players.map((player) => atCutoff(player, cutoff, dataCutoff)).filter(Boolean);
            const samples = samplesFor(snapshot, ci ? Math.min(iterations, 120) : 0, `${seed}:${arm}:${cutoff}`);
            pointSamples[arm] = samples;
            pointMetrics[arm] = baseMetrics(snapshot, samples, ci);
            point.arms.push({ arm, metrics: pointMetrics[arm] });
        }
        if (control !== null && pointMetrics[control]) attachControl(pointMetrics, pointSamples, control);
        return point;
    });
    return { control, confidence: ci ? 0.95 : null, selectedDistribution: dist, arms, series };
}
