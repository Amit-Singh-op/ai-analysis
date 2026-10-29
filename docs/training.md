# Teaching the model

Every question is planned by the local model (Ollama, `PLANNER_MODEL` in `.env`). There are no hand-written rules; when it gets something wrong, correct it and it learns from the example.

## In the chat

Under every answer there's **Not right?**. Say what you meant, the model tries again, and **Save — this is right** teaches it.

## From the command line (`npm run fix`)

```bash
npm run fix                                   # recent questions the model answered, newest first
npm run fix -- 2 "list every shipment the device is on, don't filter by status"
```

The model plans the question again with your note and shows the new answer. Answer `y` if it's right and it's saved to `data/plan-examples.json`. From the next question on (no restart):

- the exact same question, in the same place in a conversation, uses the saved plan and skips the model;
- similar questions show the model the corrected example (with device and shipment numbers replaced by placeholders), so it doesn't repeat the mistake for other devices or shipments.

Different wording for the same mistake may need its own correction. Once a few hundred corrections exist, they can also be used to fine-tune the model on a GPU.
