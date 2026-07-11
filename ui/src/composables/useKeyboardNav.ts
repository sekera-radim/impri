import { ref, computed } from 'vue'

/**
 * Encapsulates keyboard-navigation state for the inbox list.
 * The parent component (InboxList) registers the actual keydown listener
 * and calls the exported methods based on which key was pressed.
 */
export function useKeyboardNav() {
  const focusedIdx = ref(-1)
  // Use a plain ref wrapping a Set; we replace the Set reference on mutation
  // so Vue 3 reactivity picks up changes.
  const _selectedIds = ref<Set<string>>(new Set())

  const selectedIds = computed(() => _selectedIds.value)
  const isBulkMode = computed(() => _selectedIds.value.size > 0)
  const selectedCount = computed(() => _selectedIds.value.size)

  function focusIdx(idx: number, listLength: number): void {
    if (listLength === 0) return
    focusedIdx.value = ((idx % listLength) + listLength) % listLength
  }

  function focusNext(listLength: number): void {
    focusIdx(focusedIdx.value + 1, listLength)
  }

  function focusPrev(listLength: number): void {
    focusIdx(focusedIdx.value - 1, listLength)
  }

  function toggleSelect(id: string): void {
    const next = new Set(_selectedIds.value)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    _selectedIds.value = next
  }

  function selectAll(ids: string[]): void {
    _selectedIds.value = new Set(ids)
  }

  function deselectAll(): void {
    _selectedIds.value = new Set()
    // Do NOT reset focusedIdx so the user can continue navigating
  }

  function isSelected(id: string): boolean {
    return _selectedIds.value.has(id)
  }

  return {
    focusedIdx,
    selectedIds,
    isBulkMode,
    selectedCount,
    focusNext,
    focusPrev,
    toggleSelect,
    selectAll,
    deselectAll,
    isSelected,
  }
}

/**
 * Returns true when a form field (input/textarea/select/contenteditable) has focus.
 * Used to suppress shortcuts while typing.
 */
export function isFormFieldFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable
  )
}
