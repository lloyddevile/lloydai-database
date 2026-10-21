import app from "./worker.js";

export default {
  fetch(request, env, context) {
    return app.fetch(request, env, context);
  },
};
