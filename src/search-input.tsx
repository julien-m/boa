import { X } from "lucide-react";
import { type ComponentProps, type RefObject, useRef } from "react";
import { useFileLabels } from "./file-workspace-labels";

type Props = Omit<ComponentProps<"input">, "value" | "ref"> & {
	value: string;
	onClear: () => void;
	inputRef?: RefObject<HTMLInputElement | null>;
};

export function SearchInput({ value, onClear, inputRef, onKeyDown, ...props }: Props) {
	const localRef = useRef<HTMLInputElement>(null);
	const ref = inputRef ?? localRef;
	const l = useFileLabels();
	const clear = () => {
		onClear();
		ref.current?.focus();
	};
	return (
		<div className="clearable-search">
			<input
				{...props}
				ref={ref}
				value={value}
				onKeyDown={(event) => {
					if (event.key === "Escape" && value && !event.nativeEvent.isComposing) {
						event.preventDefault();
						event.stopPropagation();
						clear();
					} else onKeyDown?.(event);
				}}
			/>
			{value && (
				<button
					type="button"
					className="icon-button search-clear"
					aria-label={l.clear}
					title={l.clear}
					onClick={clear}
				>
					<X size={13} />
				</button>
			)}
		</div>
	);
}
