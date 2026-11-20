/** The bar above a chat input: drag it up to make the input taller, down to make it smaller. */
export function InputResizeGrip({
	onPointerDown,
}: {
	onPointerDown: (e: React.PointerEvent) => void;
}) {
	return (
		<div
			className="input-resize-grip"
			onPointerDown={onPointerDown}
			title="Drag to resize the message box"
			aria-hidden="true"
		>
			<span />
		</div>
	);
}
