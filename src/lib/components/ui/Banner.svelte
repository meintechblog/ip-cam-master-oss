<script lang="ts">
	let { message, linkText, linkHref }: { message: string; linkText: string; linkHref: string } =
		$props();
</script>

<div class="bg-accent/10 border border-accent/30 rounded-lg p-4 mb-4 flex items-center gap-3">
	<span class="text-text-primary text-sm">{message}</span>
	<a
		href={linkHref}
		class="text-accent hover:text-accent/80 text-sm font-medium underline underline-offset-2"
	>
		{linkText}
	</a>
</div>
