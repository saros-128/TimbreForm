interface SignalMeterProps {
  rms: number;
  inputPeakDb: number;
  noiseFloorDb: number;
}

export function SignalMeter({ rms, inputPeakDb, noiseFloorDb }: SignalMeterProps) {
  const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 70) / 65));
  const clipping = inputPeakDb > -1;
  return (
    <div className="signal" title={`Входной пик ${inputPeakDb.toFixed(1)} dBFS · шум ${noiseFloorDb.toFixed(1)} dB`}>
      <span className="signal-label">IN</span>
      <span className="signal-track">
        <span
          className={clipping ? "signal-level clipping" : "signal-level"}
          style={{ width: `${level * 100}%` }}
        />
      </span>
      <span className="signal-db">{Number.isFinite(inputPeakDb) ? inputPeakDb.toFixed(0) : "—"} dB</span>
    </div>
  );
}
