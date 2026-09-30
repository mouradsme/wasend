// One transient message at the bottom of the screen: confirmations and errors.
export const toast = $state({ text: "", error: false });

let timer;
function show(text, error) {
  clearTimeout(timer);
  toast.text = text;
  toast.error = error;
  timer = setTimeout(() => { toast.text = ""; }, error ? 6000 : 3500);
}

export const say = (text) => show(text, false);
export const fail = (error) => show(error instanceof Error ? error.message : String(error), true);
