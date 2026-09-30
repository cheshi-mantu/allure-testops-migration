import { describe, expect, it } from "vitest";
import { readTable } from "./parse.js";
import { suggestColumns } from "./suggest.js";

/**
 * Layouts seen in real customer exports, with made-up content. Each test pins what the tool
 * suggests for the columns, so a change in the heuristics shows up here.
 */
function suggested(csv: string): Record<string, string> {
  const table = readTable(Buffer.from(csv), { delimiter: "auto", quote: '"', encoding: "auto" });
  return Object.fromEntries([...suggestColumns(table)].map(([column, s]) => [column, s.target.kind + (s.separator ? ` [${s.separator}]` : "")]));
}

describe("suggestColumns", () => {
  it("reads the documented generic layout", () => {
    const csv = `allure_id,name,description,precondition,scenario,expected_result,tested_feature,tested_story,tags,created_by,supervised_by,useful_links,issue_tracker
11,Login,Checks login,Account exists,"Open
\tType",all good,Auth,Successful login,"regular, critical",jane,john,"https://a.example, https://b.example",AE-5
12,Logout,Checks logout,Logged in,Click,signed out,Auth,Successful logout,regular,jane,john,https://a.example,AE-6
`;
    expect(suggested(csv)).toEqual({
      allure_id: "sourceId",
      name: "name",
      description: "description",
      precondition: "precondition",
      scenario: "scenario",
      expected_result: "expectedResult",
      tested_feature: "customField",
      tested_story: "customField",
      tags: "tag [,]",
      created_by: "owner",
      supervised_by: "customField",
      useful_links: "link [,]",
      issue_tracker: "issue [,]",
    });
  });

  it("reads a TestRail CSV export with separate step and expected result columns", () => {
    const csv = `"ID","Title","Created By","Created On","Expected Result","Preconditions","Priority","References","Section","Section Depth","Section Hierarchy","Steps","Steps (new)","Steps (new) (Expected Result)","Steps (new) (Step)","Suite ID","Updated On"
"C1","Install","Ann Smith","2/11/2020 5:57 PM","","Installer ready","High","","Setup","0","Setup","","1. Run
Expected Result:
Runs","1. Runs","1. Run","S2","2/24/2020 3:35 PM"
"C2","Remove","Bob Brown","8/27/2019 6:42 PM","","","Low","","Setup","0","Setup","","1. Quit","1. Gone","1. Quit","S2","2/13/2020 5:21 PM"
`;
    expect(suggested(csv)).toMatchObject({
      ID: "sourceId",
      Title: "name",
      "Created By": "owner",
      "Created On": "ignore",
      "Expected Result": "ignore",
      Preconditions: "precondition",
      References: "ignore",
      "Section Depth": "ignore",
      Steps: "ignore",
      "Steps (new)": "ignore",
      "Steps (new) (Expected Result)": "scenarioExpected",
      "Steps (new) (Step)": "scenario",
      "Suite ID": "ignore",
      "Updated On": "ignore",
    });
  });

  it("picks a header mentioning a name or title, skipping names of other things", () => {
    const csv = `Key,Project Name,Author Name,Case Title EN,Notes
K-1,Shop,ann,Login works,first note
K-2,Shop,bob,Logout works,second note
K-3,Shop,ann,Search works,third note
`;
    const result = suggested(csv);
    expect(result["Case Title EN"]).toBe("name");
    expect(Object.entries(result).filter(([, kind]) => kind === "name")).toHaveLength(1);
  });

  it("finds a Russian name header by substring", () => {
    const csv = `Номер;Название проверки;Комментарий\n1;Вход;а\n2;Выход;б\n3;Поиск;в\n`;
    expect(suggested(csv)["Название проверки"]).toBe("name");
  });

  it("reads Russian headers and does not guess a name column when no header names one", () => {
    const csv = `﻿ID;Feature;Story;Предусловия;Шаги;ОР;Тип теста;Epic\r
1;Вход;Вход по паролю;Открыт сайт;1. Ввести логин и пароль;1. Вход выполнен;positive;Портал\r
2;Страница;Выход;Выполнен вход;"1. Нажать аватар
2. Нажать Выйти";"1. Меню открыто
2. Открыт экран входа";positive;Портал\r
3;Страница;Обновление;Выполнен вход;1. Нажать Обновить;1. Данные обновлены;positive;Портал\r
`;
    expect(suggested(csv)).toEqual({
      ID: "sourceId",
      Feature: "customField",
      Story: "customField",
      Предусловия: "precondition",
      Шаги: "scenario",
      ОР: "scenarioExpected",
      "Тип теста": "customField",
      Epic: "customField",
    });
  });

  it("reads steps written with markers on one line", () => {
    const csv = `id;name;scenario;expected_result;JIRA;links;assignees
1;One;Step: open Step: click;done;TP-1;http://a.example,https://b.example;"ann,bob"
2;Two;Step: send Step: check;ok;TP-2;https://b.example;carl
`;
    expect(suggested(csv)).toEqual({
      id: "sourceId",
      name: "name",
      scenario: "scenario",
      expected_result: "expectedResult",
      JIRA: "issue [,]",
      links: "link [,]",
      assignees: "role [,]",
    });
  });
});
