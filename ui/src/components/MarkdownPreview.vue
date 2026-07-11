<template>
  <!-- Plain text: wrap in pre for whitespace preservation -->
  <pre v-if="format === 'plain'" class="preview-plain">{{ body }}</pre>

  <!-- Diff: monospace block with basic line coloring -->
  <pre v-else-if="format === 'diff'" class="preview-diff"><span
    v-for="(line, i) in diffLines"
    :key="i"
    :class="lineClass(line)"
  >{{ line }}
</span></pre>

  <!-- Markdown: parsed + DOMPurify sanitized, then v-html on the sanitized output -->
  <!-- DOMPurify strips all scripts and dangerous attributes before we touch the DOM -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div v-else class="preview-markdown" v-html="safeHtml" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Force rel="noopener noreferrer" on any element that carries a target attribute.
// Without this, a sanitised <a target="_blank"> gives the opened tab a live
// window.opener reference back to the inbox session (reverse tabnapping).
// The hook runs once per sanitize() call, after DOMPurify processes each node.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute('target')) {
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const props = defineProps<{
  format: 'markdown' | 'plain' | 'diff'
  body: string
}>()

const diffLines = computed(() => props.body.split('\n'))

function lineClass(line: string): string {
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-remove'
  if (line.startsWith('@')) return 'diff-hunk'
  return ''
}

const safeHtml = computed(() => {
  if (props.format !== 'markdown') return ''
  const raw = marked.parse(props.body) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    FORCE_BODY: true,
  })
})
</script>

<style scoped>
.preview-plain,
.preview-diff {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Roboto Mono', monospace;
  font-size: 0.85rem;
  margin: 0;
}

.preview-markdown {
  font-size: 0.9rem;
  line-height: 1.6;
}

.preview-markdown :deep(a) {
  color: rgb(var(--v-theme-primary));
}

.preview-markdown :deep(code) {
  font-family: 'Roboto Mono', monospace;
  font-size: 0.85em;
  background: rgba(0, 0, 0, 0.06);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}

.v-theme--dark .preview-markdown :deep(code) {
  background: rgba(128, 128, 128, 0.15);
}

.preview-markdown :deep(pre > code) {
  background: none;
  padding: 0;
}

.preview-markdown :deep(pre) {
  background: rgba(0, 0, 0, 0.06);
  padding: 0.75em 1em;
  border-radius: 4px;
  overflow-x: auto;
}

.v-theme--dark .preview-markdown :deep(pre) {
  background: rgba(128, 128, 128, 0.15);
}

.preview-markdown :deep(blockquote) {
  border-left: 3px solid rgba(0, 0, 0, 0.2);
  margin: 0;
  padding-left: 1em;
  color: rgba(0, 0, 0, 0.6);
}

.v-theme--dark .preview-markdown :deep(blockquote) {
  border-left: 3px solid rgba(128, 128, 128, 0.4);
  color: rgba(255, 255, 255, 0.6);
}

/* Light-mode diff colors */
.diff-add {
  color: #2e7d32;
  background: rgba(46, 125, 50, 0.08);
  display: block;
}

.diff-remove {
  color: #c62828;
  background: rgba(198, 40, 40, 0.08);
  display: block;
}

.diff-hunk {
  color: #1565c0;
  display: block;
}

/* Dark-mode diff colors — lighter shades for readability */
.v-theme--dark .diff-add {
  color: #81c784;
  background: rgba(129, 199, 132, 0.1);
}

.v-theme--dark .diff-remove {
  color: #ef9a9a;
  background: rgba(239, 154, 154, 0.1);
}

.v-theme--dark .diff-hunk {
  color: #90caf9;
}
</style>
