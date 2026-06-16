/** Progress ring — value is 0..1. */
export function Ring({ value, size = 30, stroke = 3 }: { value: number; size?: number; stroke?: number }) {
	const r = (size - stroke) / 2;
	const c = 2 * Math.PI * r;
	return (
		<div className="ring" style={{ width: size, height: size }}>
			<svg width={size} height={size} aria-hidden="true">
				<circle className="ring-bg" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
				<circle
					className="ring-fg"
					cx={size / 2}
					cy={size / 2}
					r={r}
					strokeWidth={stroke}
					strokeDasharray={c}
					strokeDashoffset={c * (1 - value)}
				/>
			</svg>
			{size >= 38 && <span className="ring-lab">{Math.round(value * 100)}</span>}
		</div>
	);
}
