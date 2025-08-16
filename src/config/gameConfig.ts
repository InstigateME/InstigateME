/**
 * Конфигурация игры - основные настройки и константы
 */

// Настройки игры
export const GAME_CONFIG = {
  // Максимальное количество игроков в комнате
  MAX_PLAYERS: 50,
  
  // Минимальное количество игроков для старта игры
  MIN_PLAYERS: 3,
  
  // Общее количество раундов в игре
  TOTAL_ROUNDS: 16,
  
  // Таймауты и интервалы (в миллисекундах)
  HEARTBEAT_INTERVAL: 2000, // 2 секунды
  HEARTBEAT_TIMEOUT: 5000,  // 5 секунд
  RECONNECTION_TIMEOUT: 10000, // 10 секунд для переподключения
  HOST_DISCOVERY_TIMEOUT: 3000, // 3 секунды на опрос хоста
  HOST_GRACE_PERIOD: 8000, // 8 секунд ожидания восстановления хоста
  HOST_RECOVERY_ATTEMPTS: 3, // Количество попыток восстановления
  HOST_RECOVERY_INTERVAL: 2000, // Интервал между попытками восстановления
  MESH_RESTORATION_DELAY: 1000, // Задержка восстановления mesh-соединений
  PRESENCE_REJOIN_GRACE: 4000, // 4 секунды на быстрое переподключение без метки "Отсутствует"
} as const

// Палитра цветов для игроков (WCAG-friendly)
export const PLAYER_COLORS = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#C7F464', // Lime
  '#FFA500', // Orange
  '#AA66CC', // Purple
  '#FFD93D', // Yellow
  '#2ECC71', // Green
  '#E74C3C', // Dark Red
  '#1ABC9C', // Turquoise
  '#3498DB', // Blue
  '#9B59B6', // Purple
  '#F39C12', // Orange
  '#27AE60', // Green
  '#E67E22', // Orange
  '#8E44AD', // Purple
  '#2980B9', // Blue
  '#16A085', // Dark Turquoise
  '#D35400', // Dark Orange
  '#7F8C8D', // Gray
] as const

// Префиксы для генерации
export const NICKNAME_PREFIX = 'Player'

// Слова для генерации ID комнат
export const ROOM_ID_WORDS = {
  adjectives: ['RED', 'BLUE', 'GREEN', 'GOLD', 'SILVER', 'PURPLE', 'ORANGE', 'PINK'],
  nouns: ['DRAGON', 'TIGER', 'EAGLE', 'WOLF', 'LION', 'BEAR', 'SHARK', 'PHOENIX'],
} as const

// Карточки по умолчанию для игроков
export const DEFAULT_CARDS = {
  voting: ['Голос 1', 'Голос 2'],
  betting: ['0', '±', '+'],
} as const

// Версия протокола
export const PROTOCOL_VERSION = 1