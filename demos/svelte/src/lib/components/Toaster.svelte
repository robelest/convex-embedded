<script lang="ts">
	import { Toaster as Sonner, type ToasterProps } from "svelte-sonner";

	let { ...restProps }: ToasterProps = $props();
</script>

<Sonner
	class="demo-toaster"
	theme="light"
	position="top-center"
	visibleToasts={3}
	duration={2600}
	toastOptions={{ class: "demo-toast" }}
	style="--normal-bg: white; --normal-text: var(--color-gray-900); --normal-border: var(--color-gray-300);"
	{...restProps}
/>
