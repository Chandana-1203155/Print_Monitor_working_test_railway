/**
 * Count selected pages from a page range string such as "1-5, 8, 10-12".
 * @param {string} range
 * @param {number} totalPages
 * @returns {number}
 */
function calculateRangePages(range, totalPages) {
  if (!range || range.trim() === '' || range.trim().toLowerCase() === 'all') {
    return totalPages;
  }
  const selected = new Set();
  const parts = range.split(',').map(s => s.trim());
  for (const part of parts) {
    if (!part) continue;
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) continue;
      for (let p = Math.max(1, start); p <= Math.min(end, totalPages); p++) {
        selected.add(p);
      }
    } else {
      const p = parseInt(part, 10);
      if (!isNaN(p) && p >= 1 && p <= totalPages) {
        selected.add(p);
      }
    }
  }
  return selected.size;
}

module.exports = { calculateRangePages };
