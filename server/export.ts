import ExcelJS from 'exceljs';
import { monthLabel } from '../shared/calendar.js';
import { decimalHu, formatPlate } from '../shared/plate.js';
import type { Company, Driver, GenerateResult, Vehicle } from '../shared/types.js';

const thin = { style: 'thin' as const, color: { argb: 'FF9CA3AF' } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

export const formatNorm = (v: Vehicle) => `${decimalHu(v.consumption)} L/100km`;

/** One worksheet per month, laid out like the classic paper-style útnyilvántartás. */
export async function buildWorkbook(opts: {
  company: Company;
  vehicle: Vehicle;
  driver: Driver;
  result: GenerateResult;
  fuelPrices: Record<string, number>;
}) {
  const { company, vehicle, driver, result, fuelPrices } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Menet Mester';

  for (const month of result.months) {
    const ws = wb.addWorksheet(monthLabel(month.month), {
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    ws.columns = [11, 9, 9, 9, 9, 9, 10, 10, 9].map((width) => ({ width }));
    const set = (addr: string, value: ExcelJS.CellValue, merge?: string) => {
      if (merge) ws.mergeCells(`${addr}:${merge}`);
      ws.getCell(addr).value = value;
      return ws.getCell(addr);
    };

    const title = set('C1', 'Útnyilvántartás', 'F1');
    title.font = { size: 16, bold: true };
    title.alignment = { horizontal: 'center' };

    set('A3', 'Cég neve :'); set('C3', company.name);
    set('A4', 'Cím :'); set('C4', company.address);
    set('A5', 'Adószám :'); set('C5', company.taxNumber);

    set('A7', 'Rendszám:'); set('C7', formatPlate(vehicle.plate), 'D7');
    set('E7', 'Jármű kat :'); set('H7', vehicle.category, 'I7');
    set('A8', 'Típus :'); set('C8', vehicle.model, 'D8');
    set('E8', 'Üzemanyag :'); set('H8', vehicle.fuel, 'I8');
    set('A9', 'Vezető :'); set('C9', driver.name, 'D9');
    set('E9', 'Norma (L/100Km) :'); set('H9', formatNorm(vehicle), 'I9');
    set('A10', 'Adószám :'); set('C10', driver.taxNumber, 'D10');
    set('E10', 'Kezdő Km :'); set('H10', month.startOdometer, 'I10').alignment = { horizontal: 'left' };
    set('A11', 'Cím :'); set('C11', driver.address);
    set('G11', `Dátum: ${monthLabel(month.month)}`, 'I11');
    for (const r of [3, 4, 5, 7, 8, 9, 10, 11]) ws.getRow(r).getCell(3).font = { bold: true };
    for (const a of ['H7', 'H8', 'H9', 'H10']) ws.getCell(a).font = { bold: true };

    const head = 13;
    set(`A${head}`, 'Dátum');
    set(`B${head}`, 'Útvonal', `F${head}`);
    set(`G${head}`, 'Partner', `H${head}`);
    set(`I${head}`, 'Km');
    for (const c of ['A', 'B', 'G', 'I']) {
      const cell = ws.getCell(`${c}${head}`);
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
    }

    let row = head + 1;
    for (const leg of month.legs) {
      const d = set(`A${row}`, new Date(`${leg.date}T00:00:00Z`));
      d.numFmt = 'yyyy.mm.dd';
      d.alignment = { horizontal: 'left' };
      set(`B${row}`, `${leg.fromAddress} – ${leg.toAddress}`, `F${row}`).alignment = { shrinkToFit: true };
      set(`G${row}`, leg.partner, `H${row}`).alignment = { shrinkToFit: true };
      set(`I${row}`, leg.km).numFmt = '0.0';
      row++;
    }
    for (let r = head; r < row; r++) for (let c = 1; c <= 9; c++) ws.getRow(r).getCell(c).border = box;

    const last = Math.max(row - 1, head + 1);
    const price = fuelPrices[month.month] ?? 0;
    const cost = Math.round((month.totalKm * vehicle.consumption * price) / 100);
    const s = row + 2;
    set(`E${s}`, vehicle.fuel, `F${s}`).alignment = { horizontal: 'right' };
    const p = set(`G${s}`, price, `H${s}`);
    p.numFmt = '#,##0" Ft/L"';
    set(`E${s + 1}`, 'Összes út Km:', `F${s + 1}`).alignment = { horizontal: 'right' };
    const t = set(`G${s + 1}`, { formula: `SUM(I${head + 1}:I${last})`, result: month.totalKm }, `H${s + 1}`);
    t.numFmt = '#,##0.0" Km"';
    set(`E${s + 2}`, 'Üzemanyag költség:', `F${s + 2}`).alignment = { horizontal: 'right' };
    const c = set(
      `G${s + 2}`,
      { formula: `ROUND(G${s + 1}*${vehicle.consumption}/100*G${s},0)`, result: cost },
      `H${s + 2}`,
    );
    c.numFmt = '#,##0" Ft"';
    for (const a of [`G${s}`, `G${s + 1}`, `G${s + 2}`]) ws.getCell(a).font = { bold: true };

    set(`A${s + 5}`, 'Aláírás:');
    ws.getCell(`B${s + 5}`).border = { bottom: thin };
    ws.mergeCells(`B${s + 5}:D${s + 5}`);
  }

  return wb.xlsx.writeBuffer();
}
