const { calculateRangePages } = require('../backend/utils/printPages');

describe('calculateRangePages', () => {
  test('returns total pages when range is empty or All', () => {
    expect(calculateRangePages('', 20)).toBe(20);
    expect(calculateRangePages('All', 20)).toBe(20);
    expect(calculateRangePages('all', 20)).toBe(20);
  });

  test('counts a single range correctly', () => {
    expect(calculateRangePages('1-5', 20)).toBe(5);
    expect(calculateRangePages('5-10', 20)).toBe(6);
  });

  test('counts mixed ranges without duplicates', () => {
    expect(calculateRangePages('1-5, 8, 10-12', 20)).toBe(9);
    expect(calculateRangePages('1-3, 2-4', 20)).toBe(4);
  });

  test('clips values outside 1..totalPages', () => {
    expect(calculateRangePages('0-5, 18-25', 20)).toBe(8);
    expect(calculateRangePages('25-30', 20)).toBe(0);
  });
});
