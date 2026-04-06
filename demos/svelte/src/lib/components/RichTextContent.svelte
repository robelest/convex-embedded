<script lang="ts">
	import type { JSONContent } from "@tiptap/core";

	import { renderRichTextHtml } from "$lib/tiptap";

	let { value } = $props<{ value: JSONContent }>();

	const html = $derived(renderRichTextHtml(value));
</script>

<div class="richtext-content">{@html html}</div>
