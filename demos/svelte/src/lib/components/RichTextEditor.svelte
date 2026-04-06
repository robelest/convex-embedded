<script lang="ts">
	import { Editor } from "@tiptap/core";
	import { onDestroy, onMount } from "svelte";

	import type { ProseContent } from "@robelest/convex-embedded/crdt";
	import {
		cloneRichTextContent,
		normalizeRichTextContent,
		tiptapExtensions,
	} from "$lib/tiptap";

	let {
		value,
		onChange,
		placeholder = "Write something...",
		className = "",
	} = $props<{
		value: ProseContent;
		onChange: (value: ProseContent) => void;
		placeholder?: string;
		className?: string;
	}>();

	let element = $state<HTMLDivElement | null>(null);
	let editor = $state<Editor | null>(null);
	let lastSerializedValue = "";

	onMount(() => {
		if (!element) return;
		lastSerializedValue = JSON.stringify(normalizeRichTextContent(value));

		editor = new Editor({
			element,
			extensions: tiptapExtensions,
			content: normalizeRichTextContent(value),
			editorProps: {
				attributes: {
					class: "richtext-editor__content",
					"data-placeholder": placeholder,
				},
			},
			onUpdate: ({ editor: currentEditor }) => {
				const next = cloneRichTextContent(currentEditor.getJSON());
				lastSerializedValue = JSON.stringify(next);
				onChange(next);
			},
		});

		return () => {
			editor?.destroy();
			editor = null;
		};
	});

	$effect(() => {
		if (!editor) return;
		const normalized = normalizeRichTextContent(value);
		const serialized = JSON.stringify(normalized);
		if (serialized === lastSerializedValue) {
			return;
		}
		lastSerializedValue = serialized;
		editor.commands.setContent(normalized, { emitUpdate: false });
	});

	onDestroy(() => {
		editor?.destroy();
		editor = null;
	});
</script>

<div class={`richtext-editor ${className}`.trim()}>
	<div bind:this={element}></div>
</div>
