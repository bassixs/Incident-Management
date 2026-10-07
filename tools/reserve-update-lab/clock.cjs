// Isolated test clock only; not copied into runtime image.
const RealDate = Date;
const base = RealDate.parse(process.env.SYNTHETIC_CLOCK);
if (!Number.isFinite(base) || process.env.BOT_TOKEN !== 'synthetic-container-token') throw Error('Invalid synthetic clock');
const started = RealDate.now();
global.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(base + RealDate.now() - started); }
  static now() { return base + RealDate.now() - started; }
};
