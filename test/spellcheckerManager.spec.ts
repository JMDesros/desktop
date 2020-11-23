import anyTest, { TestInterface } from 'ava';
import { Driver, createDriver } from './driver';

const StoreKeys = {
  SelectedSpellCheckerLanguageCodes: 'selectedSpellCheckerLanguageCodes',
};

const test = anyTest as TestInterface<Driver>;

test.before(async (t) => {
  t.context = await createDriver();
});
test.after.always(async (t) => {
  await t.context.stop();
});

if (process.platform === 'darwin') {
  test('does not create a manager on Mac', async (t) => {
    t.falsy(await t.context.spellchecker.manager());
  });
} else {
  const language = 'cs';

  test.serial(
    "adds a clicked language menu item to the store and session's languages",
    async (t) => {
      await t.context.appMenu.clickLanguage(language as any);
      const data = await t.context.store.dataOnDisk();
      t.true(
        data[StoreKeys.SelectedSpellCheckerLanguageCodes].includes(language)
      );
      t.true((await t.context.spellchecker.languages()).includes(language));
    }
  );

  test.serial(
    "removes a clicked language menu item to the store's and session's languages",
    async (t) => {
      await t.context.appMenu.clickLanguage(language as any);
      const data = await t.context.store.dataOnDisk();
      t.false(
        data[StoreKeys.SelectedSpellCheckerLanguageCodes].includes(language)
      );
      t.false((await t.context.spellchecker.languages()).includes(language));
    }
  );
}
