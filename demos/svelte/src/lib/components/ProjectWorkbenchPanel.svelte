	<script lang="ts">
		import type { ConvexClient } from "convex/browser";
		import { getContext, onMount } from "svelte";
		import { toast } from "svelte-sonner";

		import { api } from "$convex/_generated/api.js";
		import type { RemoteState } from "@robelest/convex-embedded/browser";
		import type { ProseContent } from "@robelest/convex-embedded/crdt";
		import RichTextContent from "$lib/components/RichTextContent.svelte";
	import RichTextEditor from "$lib/components/RichTextEditor.svelte";
	import {
		createEmptyRichTextContent,
		normalizeRichTextContent,
		richTextToPlainText,
	} from "$lib/tiptap";

	let { project, client, canEditProject } = $props<{
		project: {
			_id: string;
			name: string;
			identifier: string;
			description: string;
			openIssueCount: number;
			issueCount?: number;
		};
		client: ConvexClient;
			canEditProject: boolean;
		}>();

		const getSyncStatus = getContext<() => RemoteState>("syncStatus");

		let innerWidth = $state(1440);
	let notesOpen = $state(false);
	let assistantOpen = $state(false);
	let notes = $state("");
	let assistantDraft = $state("");
	let assistantMessages = $state<Array<{ role: "user" | "assistant"; content: string }>>([]);
	let isAskingAssistant = $state(false);
	let isEditingDescription = $state(false);
	let isSavingDescription = $state(false);
	let liveDescription = $state<ProseContent>(createEmptyRichTextContent());
	let editDescription = $state<ProseContent>(createEmptyRichTextContent());
	let errorMessage = $state<string | null>(null);

	let notesPosition = $state({ x: 32, y: 140 });
	let assistantPosition = $state({ x: 416, y: 140 });
	let dragState = $state<
		| {
			panel: "notes" | "assistant";
			offsetX: number;
			offsetY: number;
		  }
		| null
	>(null);

	const isDesktop = $derived(innerWidth >= 960);
	const notesStorageKey = $derived(
		`convex-embedded:project-notes:${project._id}`,
	);
	const layoutStorageKey = $derived(
		`convex-embedded:project-panels:${project._id}`,
	);
	const assistantStorageKey = $derived(
		`convex-embedded:project-assistant:${project._id}`,
	);
		const hasDescription = $derived(
			richTextToPlainText(liveDescription).length > 0,
		);
		const assistantOffline = $derived(getSyncStatus().status === "offline");

		function showAssistantOfflineToast() {
			toast.warning("Project assistant is unavailable offline.");
		}

	onMount(() => {
		const normalized = normalizeRichTextContent(project.description);
		liveDescription = normalized;
		editDescription = normalized;

		const storedNotes = window.localStorage.getItem(notesStorageKey);
		notes = storedNotes ?? "";

		const storedLayout = window.localStorage.getItem(layoutStorageKey);
		if (storedLayout) {
			try {
				const parsed = JSON.parse(storedLayout) as {
					notesOpen?: boolean;
					assistantOpen?: boolean;
					notesPosition?: { x: number; y: number };
					assistantPosition?: { x: number; y: number };
				};
				notesOpen = parsed.notesOpen ?? false;
				assistantOpen = parsed.assistantOpen ?? false;
				notesPosition = parsed.notesPosition ?? notesPosition;
				assistantPosition = parsed.assistantPosition ?? assistantPosition;
			} catch {
				// ignore malformed persisted layout
			}
		}

		const storedAssistant = window.localStorage.getItem(assistantStorageKey);
		if (storedAssistant) {
			try {
				assistantMessages = JSON.parse(storedAssistant) as Array<{
					role: "user" | "assistant";
					content: string;
				}>;
			} catch {
				// ignore malformed assistant history
			}
		}
	});

	$effect(() => {
		const normalized = normalizeRichTextContent(project.description);
		liveDescription = normalized;
		if (!isEditingDescription) {
			editDescription = normalized;
		}
	});

	$effect(() => {
		window.localStorage.setItem(notesStorageKey, notes);
	});

	$effect(() => {
		window.localStorage.setItem(
			layoutStorageKey,
			JSON.stringify({
				notesOpen,
				assistantOpen,
				notesPosition,
				assistantPosition,
			}),
		);
	});

	$effect(() => {
		window.localStorage.setItem(
			assistantStorageKey,
			JSON.stringify(assistantMessages),
		);
	});

	function startDrag(
		panel: "notes" | "assistant",
		event: PointerEvent,
	) {
		if (!isDesktop) return;
		const target = event.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		dragState = {
			panel,
			offsetX: event.clientX - rect.left,
			offsetY: event.clientY - rect.top,
		};
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragState || !isDesktop) return;
		const next = {
			x: Math.max(16, event.clientX - dragState.offsetX),
			y: Math.max(96, event.clientY - dragState.offsetY),
		};
		if (dragState.panel === "notes") {
			notesPosition = next;
		} else {
			assistantPosition = next;
		}
	}

	function stopDrag() {
		dragState = null;
	}

		async function handleAskAssistant(prompt?: string) {
			const message = (prompt ?? assistantDraft).trim();
			if (message.length === 0) return;
			if (assistantOffline) {
				showAssistantOfflineToast();
				return;
			}

			isAskingAssistant = true;
		errorMessage = null;
		const nextHistory = [...assistantMessages, { role: "user" as const, content: message }];
		assistantMessages = nextHistory;
		assistantDraft = "";
		assistantOpen = true;
		try {
			const result = await client.action(api.agent.chatProject, {
				projectId: project._id,
				history: assistantMessages,
				message,
			});
			assistantMessages = [...nextHistory, { role: "assistant", content: result.reply }];
		} catch (e: unknown) {
			errorMessage =
				e instanceof Error ? e.message : "Failed to chat about project";
			assistantMessages = assistantMessages.filter(
				(entry, index) => !(index === assistantMessages.length - 1 && entry.role === "user" && entry.content === message),
			);
		} finally {
			isAskingAssistant = false;
		}
	}

	function startEditingDescription() {
		if (!canEditProject) return;
		editDescription = liveDescription;
		isEditingDescription = true;
	}

	async function saveProjectDescription() {
		isSavingDescription = true;
		errorMessage = null;
		try {
			await client.mutation(api.projects.update, {
				projectId: project._id,
				description: editDescription,
			});
			isEditingDescription = false;
		} catch (e: unknown) {
			errorMessage =
				e instanceof Error ? e.message : "Failed to update project description";
		} finally {
			isSavingDescription = false;
		}
	}
</script>

<svelte:window bind:innerWidth onpointermove={handlePointerMove} onpointerup={stopDrag} onpointercancel={stopDrag} />

	<div class="flex flex-col gap-3 rounded border border-gray-300 bg-white p-3">
		<div class="flex items-start justify-between gap-3 max-md:flex-col max-md:items-stretch">
			<div class="flex min-w-0 flex-1 flex-col gap-1">
				<div class="flex items-center gap-2">
					<span class="font-label text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-gray-400">
						Project workbench
					</span>
					<span class="font-label text-[0.75rem] font-semibold text-gray-500">{project.identifier}</span>
				</div>
				{#if isEditingDescription}
					<RichTextEditor
						value={editDescription}
						onChange={(value) => {
							editDescription = value;
						}}
						placeholder="Describe the project..."
						className="richtext-editor--compact"
					/>
					<div class="mt-2 flex gap-1.5">
						<button class="button button--accent button--compact" type="button" onclick={saveProjectDescription} disabled={isSavingDescription}>
							{isSavingDescription ? "Saving..." : "Save"}
						</button>
						<button class="button button--secondary button--compact" type="button" onclick={() => { isEditingDescription = false; editDescription = liveDescription; }}>
							Cancel
						</button>
					</div>
				{:else if hasDescription}
					<button
						class="m-0 w-full border-0 bg-transparent p-0 text-left cursor-text font-sans text-base font-semibold leading-tight text-gray-900 hover:text-accent-600"
						type="button"
						onclick={startEditingDescription}
					>
						<RichTextContent value={liveDescription} />
					</button>
				{:else}
					<button class="m-0 border-0 bg-transparent p-0 text-left font-sans text-base font-semibold leading-tight text-gray-400 cursor-pointer hover:text-accent-600" type="button" onclick={startEditingDescription}>
						No project description yet.
					</button>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<span class="font-label text-[0.6875rem] text-gray-400">{project.openIssueCount} open issues</span>
				<button class="button button--secondary button--compact" type="button" onclick={() => (notesOpen = !notesOpen)}>
					{notesOpen ? "Hide notes" : "Notes"}
				</button>
				<button
					class="button button--secondary button--compact"
					type="button"
					onclick={() => {
						if (!assistantOpen && assistantOffline) {
							showAssistantOfflineToast();
							return;
						}
						assistantOpen = !assistantOpen;
					}}
				>
					{assistantOpen ? "Hide assistant" : "Assistant"}
				</button>
			</div>
		</div>

	{#if errorMessage}
		<p class="error-banner">{errorMessage}</p>
	{/if}
</div>

{#if notesOpen}
	<div
		class:is-floating-panel={isDesktop}
		class="project-workbench-panel project-workbench-panel--notes"
		style={isDesktop ? `left:${notesPosition.x}px; top:${notesPosition.y}px;` : undefined}
	>
		<div
			class="project-workbench-panel__header"
			onpointerdown={(event) => startDrag("notes", event)}
			role="toolbar"
			aria-label="Project notes panel controls"
			tabindex="-1"
		>
			<div class="flex items-center gap-2">
				<span class="font-label text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-gray-400">Project notes</span>
				<span class="chip chip--role">Local only</span>
			</div>
			<button class="button button--ghost text-gray-400" type="button" onclick={() => (notesOpen = false)}>Close</button>
		</div>
		<textarea
			bind:value={notes}
			class="input project-workbench-notes__textarea"
			placeholder="Track project notes, research, and local planning here."
			rows="10"
		></textarea>
	</div>
{/if}

{#if assistantOpen}
	<div
		class:is-floating-panel={isDesktop}
		class="project-workbench-panel project-workbench-panel--assistant"
		style={isDesktop ? `left:${assistantPosition.x}px; top:${assistantPosition.y}px;` : undefined}
	>
		<div
			class="project-workbench-panel__header"
			onpointerdown={(event) => startDrag("assistant", event)}
			role="toolbar"
			aria-label="Project assistant panel controls"
			tabindex="-1"
		>
			<div class="flex items-center gap-2">
				<span class="font-label text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-gray-400">Project assistant</span>
				<span class="chip chip--grant">Remote only</span>
			</div>
			<button class="button button--ghost text-gray-400" type="button" onclick={() => (assistantOpen = false)}>Close</button>
		</div>
		<div class="project-workbench-chat">
			{#if assistantMessages.length > 0}
				<div class="project-workbench-chat__messages">
				{#each assistantMessages as message, index (`${message.role}-${index}`)}
					<div class={`max-w-[85%] border px-3 py-2 text-[0.8125rem] leading-relaxed whitespace-pre-wrap ${message.role === "user" ? "self-end border-accent-200 bg-accent-50 text-gray-900" : "self-start border-gray-200 bg-white text-gray-800"}`}>
						<div class="mb-1 font-label text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-gray-400">
							{message.role === "user" ? "You" : "Assistant"}
						</div>
						{message.content}
					</div>
				{/each}
				</div>
			{/if}
		</div>
		<form class="project-workbench-chat__composer" onsubmit={(event) => { event.preventDefault(); void handleAskAssistant(); }}>
			<input
				bind:value={assistantDraft}
				class="input input--compact flex-1"
				placeholder="Ask what to prioritize, what is blocked, or how the project is going..."
				type="text"
			/>
			<button class="button button--accent button--compact" type="submit" disabled={isAskingAssistant || assistantDraft.trim().length === 0}>
				{isAskingAssistant ? "Sending..." : "Send"}
			</button>
		</form>
	</div>
{/if}
