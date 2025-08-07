<template>
  <!-- Триггер (по умолчанию — кнопка помощи). Если передан слот trigger, он переопределит этот контент -->
  <span class="rules-trigger">
    <slot name="trigger" :open="open" :close="close" :modelValue="modelValue">
      <button
        class="help-btn"
        :aria-pressed="internalOpen"
        @click.stop="open"
        aria-label="Правила игры"
        title="Правила игры"
      >
        ❓
      </button>
    </slot>
  </span>

  <!-- Модальное окно -->
  <div v-if="internalOpen" class="modal-overlay" @click.self="close">
    <div class="modal">
      <div class="modal-header">
        <h3>Правила игры</h3>
        <button class="modal-close" @click="close" aria-label="Закрыть">✕</button>
      </div>
      <div class="modal-content">
        <article class="rules">
          <header class="rules__header">
            <h4 class="rules__title">Провокатор — правила</h4>
            <p class="rules__subtitle"></p>
          </header>

          <section class="rules__section">
            <h5 class="rules__h">Провокатор — узнай, что думают о тебе друзья!</h5>
            <p class="rules__p">
              Вы давно хотели узнать, что на самом деле думают о вас друзья или знакомые? У вас
              появился отличный шанс — сыграйте с ними в игру <strong>«Провокатор»</strong>!
            </p>
          </section>

          <section class="rules__section">
            <h5 class="rules__h">Подготовка к игре</h5>
            <ol class="rules__list">
              <li>
                Соберите компанию из <strong>3–8 человек</strong> и настройтесь на увлекательную
                игру.
              </li>
              <li>
                Каждый игрок выбирает себе карточку <strong>«Провокатор»</strong> любого цвета по
                желанию. Затем каждый получает по
                <strong>2 карточки с кругляшками цветов других игроков</strong> (но не своего) и
                <strong>3 карточки ставок</strong> с символами:
                <ul class="rules__bullets">
                  <li><code>0</code> — никто не проголосует за меня;</li>
                  <li><code>±</code> — возможно, получу несколько голосов;</li>
                  <li><code>+</code> — я стану лидером голосования.</li>
                </ul>
                <em>Пример:</em> Желтый игрок получает 2 карточки синего и 2 карточки белого цвета
                (цвета других игроков), а также комплект карточек ставок.
              </li>
              <li>
                Если играете впервые, возьмите колоду карт с
                <strong>одной звездочкой <code>*</code></strong
                >, перемешайте её и положите на стол.
              </li>
              <li>
                Все карточки держатся <strong>рубашкой вверх</strong>, чтобы их не видели другие
                игроки.
              </li>
            </ol>
          </section>

          <section class="rules__section">
            <h5 class="rules__h">Как играть?</h5>
            <ol class="rules__list">
              <li>
                Игрок по очереди (например, Синий) тянет карту из колоды и
                <strong>зачитывает вопрос</strong>.
              </li>
              <li>
                Все участники (включая ведущего) выбирают,
                <strong>кто из игроков лучше всего подходит под описание</strong> из вопроса. Затем
                <strong>голосуют</strong>, выкладывая <strong>две карточки с кругляшками</strong> —
                обе можно отдать одному игроку или разделить.
              </li>
              <li>
                Прежде чем открыть результаты, <strong>все делают ставку</strong>:
                <ul class="rules__bullets">
                  <li><code>0</code> — уверен, никто не проголосует за меня;</li>
                  <li><code>±</code> — допускаю, что кто-то мог;</li>
                  <li><code>+</code> — думаю, наберу больше всего голосов.</li>
                </ul>
              </li>
              <li>
                Открываются карточки голосования:
                <ul class="rules__bullets">
                  <li>
                    Например, Белый игрок получил 3 голоса и <strong>предсказал</strong> это,
                    выложив <code>+</code> — он получает <strong>3 победных очка</strong>.
                  </li>
                  <li>
                    Синий выложил <code>0</code>, но за него проголосовали —
                    <strong>очков не получает</strong>.
                  </li>
                  <li>
                    Желтый поставил <code>+</code>, но не стал лидером — тоже
                    <strong>без очков</strong>.
                  </li>
                </ul>
              </li>
              <li>
                После подсчёта очков каждый забирает свои карточки, а
                <strong>следующий игрок тянет новый вопрос</strong>.
              </li>
            </ol>
          </section>

          <section class="rules__section">
            <h5 class="rules__h">Уровень сложности 2.0</h5>
            <p class="rules__p">
              Хотите больше <strong>провокации</strong>? Возьмите колоду с
              <strong>двумя звёздочками <code>**</code></strong> — вопросы станут острее!
            </p>
            <h6 class="rules__h" style="font-weight: 700">Правила:</h6>
            <ol class="rules__list">
              <li>Каждому понадобится <strong>лист бумаги и ручка</strong>.</li>
              <li>
                Игроки снова выбирают себе карточку «Провокатор» и по 2 карточки с кругляшками
                цветов других участников.
              </li>
              <li>Все карточки держатся <strong>рубашкой вверх</strong>.</li>
              <li>
                Игрок зачитывает вопрос. Все участники <strong>тайно голосуют</strong> двумя
                карточками (из 4-х имеющихся) за того, кто, по их мнению, должен
                <strong>отвечать на вопрос</strong>.
              </li>
              <li>
                Карты вскрываются. Игрок с большинством голосов (например, Синий)
                <strong>отвечает письменно</strong>.
              </li>
              <li>Остальные <strong>пишут предположения</strong>, что он мог ответить.</li>
              <li>
                Синий игрок показывает свой ответ. Все, кто угадал или оказался максимально близким,
                получают <strong>1 балл</strong>.
              </li>
            </ol>
          </section>

          <section class="rules__section">
            <h5 class="rules__h">Победа</h5>
            <p class="rules__p">Побеждает тот, кто наберёт больше всего очков к концу игры!</p>
          </section>
        </article>
      </div>
      <div class="modal-footer">
        <button class="btn-primary" @click="close">Понятно</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue?: boolean
  }>(),
  {
    modelValue: undefined,
  },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'open'): void
  (e: 'close'): void
}>()

// Внутреннее состояние: если проп modelValue не передан, контролируем локально
const isControlled = computed(() => typeof props.modelValue === 'boolean')
const internalOpen = ref(false)

watch(
  () => props.modelValue,
  (val) => {
    if (isControlled.value) {
      internalOpen.value = !!val
    }
  },
  { immediate: true },
)

function open() {
  if (isControlled.value) {
    emit('update:modelValue', true)
  } else {
    internalOpen.value = true
  }
  emit('open')
}

function close() {
  if (isControlled.value) {
    emit('update:modelValue', false)
  } else {
    internalOpen.value = false
  }
  emit('close')
}
</script>

<style scoped>
/* Клик-зона триггера по умолчанию не ломает стили вложенных элементов */
.rules-trigger {
  display: inline-flex;
}

/* Кнопка помощи (по умолчанию для открытия правил) */
.help-btn {
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
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    transform 0.12s ease,
    box-shadow 0.18s ease,
    border-color 0.18s ease;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  padding: 0;
  font-size: 18px;
  line-height: 1;
}
.help-btn:hover {
  background: #f0f4ff;
  color: #3730a3;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
  border-color: #dbe6f3;
}
.help-btn:active {
  transform: translateY(0);
}
.help-btn:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.25);
}
.help-btn[aria-pressed='true'] {
  background: #eef2ff;
  border-color: #c7d2fe;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15);
}

/* Modal (popup) */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 1000;
}

.modal {
  width: min(900px, 100%);
  background: #fff;
  border-radius: 14px;
  border: 1px solid #e6ecf5;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.25);
  display: flex;
  flex-direction: column;
  max-height: 80vh;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #eef2f7;
}

.modal-header h3 {
  margin: 0;
}

.modal-close {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid #e6ecf5;
  background: #f8fafc;
  color: #1f2937;
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
}

.modal-content {
  padding: 12px 16px;
  overflow: auto;
}

/* Стилизация правил */
.rules {
  display: grid;
  gap: 12px;
  color: #0f172a;
}

.rules__header {
  display: grid;
  gap: 6px;
  padding: 4px 0 8px;
  border-bottom: 1px solid #eef2f7;
}

.rules__title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 800;
  letter-spacing: 0.2px;
}

.rules__subtitle {
  margin: 0;
  color: #475569;
  font-size: 0.95rem;
}

.rules__section {
  display: grid;
  gap: 6px;
}

.rules__h {
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
  color: #1f2937;
}

.rules__p {
  margin: 0;
  line-height: 1.5;
}

.rules__list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.5;
}

.rules__bullets {
  margin: 0;
  padding-left: 18px;
  line-height: 1.5;
  list-style: disc;
}

.rules strong {
  font-weight: 800;
}

/* Адаптивность текста правил */
@media (max-width: 560px) {
  .rules__title {
    font-size: 1.05rem;
  }

  .rules__subtitle {
    font-size: 0.9rem;
  }

  .rules__h {
    font-size: 0.98rem;
  }
}

.modal-footer {
  padding: 12px 16px;
  border-top: 1px solid #eef2f7;
  display: flex;
  justify-content: flex-end;
}

.modal-footer .btn-primary {
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  color: #fff;
  border: none;
  padding: 8px 14px;
  border-radius: 10px;
  font-weight: 800;
  cursor: pointer;
}
</style>
