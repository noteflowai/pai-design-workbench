import assert from "node:assert/strict";
import test from "node:test";
import { matchCsv, matchQif, matchReport } from "../web/fai-import.js";

const plan = [{ id: "bearing-seat-diameter", label: "轴承孔 Ø（H7）" }, { id: "bearing-seat-depth", label: "轴承孔深" }, { id: "min-wall", label: "最小壁厚" }];
// The structure of the official QIF 3.0 sample (qif-community samples/QIFwidget/WIDGET_QIF_RESULTS.QIF), trimmed.
const qif = (unit = "mm", factor = "0.001") => `<?xml version="1.0" encoding="UTF-8"?>
<QIFDocument xmlns="http://qifstandards.org/xsd/qif3" versionQIF="3.0.0">
  <FileUnits><PrimaryUnits>
    <AngularUnit><SIUnitName>radian</SIUnitName><UnitName>degree</UnitName><UnitConversion><Factor>0.0174</Factor></UnitConversion></AngularUnit>
    <LinearUnit><SIUnitName>meter</SIUnitName><UnitName>${unit}</UnitName><UnitConversion><Factor>${factor}</Factor></UnitConversion></LinearUnit>
  </PrimaryUnits></FileUnits>
  <Characteristics><CharacteristicItems n="3">
    <DiameterCharacteristicItem id="49"><Name>bearing-seat-diameter</Name><CharacteristicDesignator><Designator>10</Designator></CharacteristicDesignator></DiameterCharacteristicItem>
    <DistanceBetweenCharacteristicItem id="60"><Name>5</Name><CharacteristicDesignator><Designator>轴承孔深</Designator></CharacteristicDesignator></DistanceBetweenCharacteristicItem>
    <FlatnessCharacteristicItem id="14"><Name>113</Name></FlatnessCharacteristicItem>
  </CharacteristicItems></Characteristics>
  <MeasurementsResults><MeasurementResultsSet><MeasurementResults id="1"><MeasuredCharacteristics><CharacteristicMeasurements n="3">
    <FlatnessCharacteristicMeasurement id="16"><Status><CharacteristicStatusEnum>PASS</CharacteristicStatusEnum></Status><CharacteristicItemId>14</CharacteristicItemId><Value>0.088</Value></FlatnessCharacteristicMeasurement>
    <DiameterCharacteristicMeasurement id="50"><Status><CharacteristicStatusEnum>PASS</CharacteristicStatusEnum></Status><CharacteristicItemId>49</CharacteristicItemId>
      <FeatureMeasurementIds n="1"><Id>46</Id></FeatureMeasurementIds><Value>${unit === "mm" ? "35.011000000000001" : "1.3784"}</Value></DiameterCharacteristicMeasurement>
    <DistanceBetweenCharacteristicMeasurement id="61"><CharacteristicItemId>60</CharacteristicItemId><Value>${unit === "mm" ? "11.04" : "0.4346"}</Value></DistanceBetweenCharacteristicMeasurement>
  </CharacteristicMeasurements></MeasuredCharacteristics></MeasurementResults></MeasurementResultsSet></MeasurementsResults>
</QIFDocument>`;

test("QIF 3.0 Results: measurements joined to their characteristic items by id, matched by name or designator", () => {
  const r = matchReport("part.QIF", qif(), plan);
  assert.equal(r.format, "qif");
  assert.deepEqual(r.values, { "bearing-seat-diameter": "35.011", "bearing-seat-depth": "11.04" });
  assert.deepEqual(r.unmatched, ["Flatness 113"], "a characteristic outside the plan is listed, never dropped silently");
});

test("QIF in inches is converted with the file's own factor; a unit without a factor is refused", () => {
  const r = matchQif(qif("in", "0.0254"), plan);
  assert.equal(r.values["bearing-seat-diameter"], "35.01136"); assert.equal(r.values["bearing-seat-depth"], "11.03884");
  assert.match(r.note ?? "", /in/);
  assert.throws(() => matchQif(qif("in", "x"), plan), /换算/);
  assert.throws(() => matchQif("<root/>", plan), /QIFDocument/);
});

test("CSV rows by id or label; headers ignored", () => {
  const r = matchCsv("characteristic,measured\nbearing-seat-diameter,35.012\n最小壁厚;7.96\nflatness,0.01\n", plan);
  assert.deepEqual(r.values, { "bearing-seat-diameter": "35.012", "min-wall": "7.96" });
  assert.deepEqual(r.unmatched, ["flatness"]);
});
