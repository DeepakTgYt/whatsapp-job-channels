// WhatsApp login (Baileys auth state) stored in MongoDB, so a Render restart does not log out.
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { col } = require('./db');

async function useMongoAuthState() {
  const c = col('wa_auth');
  const read = async (id) => {
    const d = await c.findOne({ _id: id });
    return d ? JSON.parse(d.data, BufferJSON.reviver) : null;
  };
  const write = (id, value) =>
    c.updateOne({ _id: id }, { $set: { data: JSON.stringify(value, BufferJSON.replacer) } }, { upsert: true });
  const remove = (id) => c.deleteOne({ _id: id });

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              let v = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
              out[id] = v;
            })
          );
          return out;
        },
        set: async (data) => {
          const jobs = [];
          for (const type in data) {
            for (const id in data[type]) {
              const v = data[type][id];
              jobs.push(v ? write(`${type}-${id}`, v) : remove(`${type}-${id}`));
            }
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write('creds', creds),
    clear: () => c.deleteMany({}),
  };
}

module.exports = { useMongoAuthState };
