function normalizeTimeToRangeStart(date, timeRange) {
  const newDate = new Date(date);
  switch (timeRange) {
    case "1h":
      newDate.setMinutes(newDate.getMinutes() - (newDate.getMinutes() % 5));
      newDate.setSeconds(0);
      newDate.setMilliseconds(0);
      break;
    case "1d":
      newDate.setHours(0, 0, 0, 0);
      break;
    case "3d":
      newDate.setDate(newDate.getDate() - 2);
      newDate.setHours(0, 0, 0, 0);
      break;
    case "7d":
    case "1w": // 1w and 7d are treated the same
      newDate.setDate(newDate.getDate() - newDate.getDay());
      newDate.setHours(0, 0, 0, 0);
      break;
    case "1m":
      newDate.setDate(1);
      newDate.setHours(0, 0, 0, 0);
      break;
    default:
      throw new Error(`Unsupported time range: ${timeRange}`);
  }
  return newDate.toISOString();
}

module.exports = {
  normalizeTimeToRangeStart,
};
