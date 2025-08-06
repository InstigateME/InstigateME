<template>
  <!-- Обертка для триггера: если слот не передан — показываем дефолтную кнопку-конверт -->
  <span class="envelope-trigger">
    <slot
      name="trigger"
      :open="open"
      :close="close"
      :modelValue="modelValue"
    >
      <button
        class="envelope-btn"
        :aria-pressed="modelValue"
        @click.stop="open"
        aria-label="Написать нам"
        title="Написать нам"
        type="button"
      >
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M20 4H4c-1.1 0-2 .9-2 2v12a2 2 0 0 0 2 2h16a2
               2 0 0 0 2-2V6c0-1.1-.9-2-2-2Zm0 4-8 5L4 8V6l8 5 8-5v2Z"
          />
        </svg>
      </button>
    </slot>
  </span>
</template>

<script setup lang="ts">
/**
 * Компонент-кнопка «конверт» для открытия внешней формы.
 * - Имеет слот `trigger` для кастомной кнопки/ссылки.
 * - По умолчанию рендерит стилизованную кнопку с иконкой конверта.
 * - При клике вызывает open(): открывает ссылку в новой вкладке.
 */
const props = withDefaults(defineProps<{
  modelValue?: boolean
  href?: string
}>(), {
  modelValue: false,
  href: 'https://docs.google.com/forms/d/e/1FAIpQLSfyF3Dq2Sr-UJtdvLUWD6JP3HWP6NCD4i4ek-M5GRlPjhWruA/viewform?usp=dialog'
})

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'close'): void
}>()

function open() {
  try {
    window.open(props.href, '_blank', 'noopener,noreferrer')
    emit('open')
  } catch {
    // ignore
  }
}
function close() {
  emit('close')
}
</script>

<style scoped>
.envelope-trigger {
  display: inline-flex;
}

/* Дефолтная кнопка-конверт */
.envelope-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: 2px solid #e1e5e9;
  background: #ffffff;
  color: #4f46e5;
  cursor: pointer;
  transition: background-color .18s ease, color .18s ease, transform .12s ease, box-shadow .18s ease, border-color .18s ease;
  box-shadow: 0 1px 2px rgba(15,23,42,0.06);
  padding: 0;
  line-height: 1;
}

.envelope-btn:hover {
  background: #f0f4ff;
  color: #3730a3;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
  border-color: #dbe6f3;
}

.envelope-btn:active {
  transform: translateY(0);
}

.envelope-btn:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(79,70,229,0.25);
}
.envelope-btn[aria-pressed="true"] {
  background: #eef2ff;
  border-color: #c7d2fe;
  box-shadow: 0 0 0 3px rgba(79,70,229,0.15);
}

.envelope-btn[aria-pressed="true"] {
  background: #eef2ff;
  border-color: #c7d2fe;
  box-shadow: 0 0 0 3px rgba(79,70,229,0.15);
}

.icon {
  width: 20px;
  height: 20px;
}
</style>
