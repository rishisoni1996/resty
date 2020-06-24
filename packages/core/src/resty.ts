import "reflect-metadata";
import express from "express";
import bodyParser from "body-parser";

import { Container } from "typedi";
import { exit } from "process";

import { MetadataKeys } from "./metadataKeys";
import { ControllerMetadata } from "./decorators/Controller";
import { HTTPMethodMetadata, HTTPMethod } from "./decorators/HttpMethods";
import { RequestParamMetadata } from "./decorators/Param";
import { Context } from "./context";
import { transformAndValidate } from "./helpers/transformAndValidate";
import { ValidationError, HTTPError } from "./errors";

interface Options {
  app?: express.Application;
  router?: express.Router;
  controllers: any[];
  middlewares?: express.RequestHandler[];
  postMiddlewares?: express.RequestHandler[];
  bodyParser?: boolean;
  handleErrors?: boolean;
  routePrefix?: string;
}

class Application {
  constructor(
    private readonly app: express.Application,
    private readonly router: express.Router,
    private readonly controllers: any[],
    private readonly middlewares?: express.RequestHandler[],
    private readonly postMiddlewares?: express.RequestHandler[],
    private readonly bodyParser?: boolean,
    private readonly handleErrors?: boolean,
    private readonly routePrefix?: string
  ) {
    try {
      this.initBodyParser(bodyParser);
      this.initPreMiddlewares();
      this.initControllers();
      this.initPostMiddlewares();
      this.initErrorHandlers();
    } catch (error) {
      console.error(error);
      exit(1);
    }
  }

  private initBodyParser(enabled: boolean = true) {
    if (enabled) {
      this.app.use(bodyParser.urlencoded({ extended: false }));
      this.app.use(bodyParser.json());
    }
  }

  private initPreMiddlewares() {
    if (this.middlewares) {
      this.middlewares.forEach((middleware) => this.app.use(middleware));
    }
  }

  private initPostMiddlewares() {
    if (this.postMiddlewares) {
      this.postMiddlewares.forEach((middleware) => this.app.use(middleware));
    }
  }

  private initControllers() {
    this.controllers.map((controller) => {
      const metadata: ControllerMetadata = Reflect.getMetadata(
        MetadataKeys.controller,
        controller
      );
      if (metadata == null) {
        // Make more useful error message like you've forgot to add @Controller or something ...
        throw Error(`${controller.name} metadata not found`);
      }
      this.initRoutes(controller, metadata);
    });

    if (this.routePrefix) {
      let routePrefix = this.routePrefix;
      // Append / if not exist in path
      if (!routePrefix.startsWith('/')) {
        routePrefix = '/' + routePrefix;
      }
      this.app.use(routePrefix, this.router)
    } else {
      this.app.use(this.router)
    }
  }

  private initRoutes(controller: any, metadata: ControllerMetadata) {
    const _router = express.Router(metadata.options);
    const arrHttpMethodMetada: HTTPMethodMetadata[] =
      Reflect.getMetadata(MetadataKeys.httpMethod, controller) ?? [];

    Container.set(controller, new controller());

    arrHttpMethodMetada.map((mehtodMetadata) => {
      const handler = this.initRequestHandler(controller, mehtodMetadata);
      const middlewares = [
        ...metadata.middlewares,
        ...mehtodMetadata.middlewares,
      ];
      switch (mehtodMetadata.method) {
        case HTTPMethod.get:
          _router.get(mehtodMetadata.path, middlewares, handler);
          break;

        case HTTPMethod.post:
          _router.post(mehtodMetadata.path, middlewares, handler);
          break;

        case HTTPMethod.put:
          _router.put(mehtodMetadata.path, middlewares, handler);
          break;

        case HTTPMethod.delete:
          _router.delete(mehtodMetadata.path, middlewares, handler);
          break;

        case HTTPMethod.patch:
          _router.patch(mehtodMetadata.path, middlewares, handler);
          break;

        case HTTPMethod.options:
          _router.options(mehtodMetadata.path, middlewares, handler);
          break;

        case HTTPMethod.head:
          _router.head(mehtodMetadata.path, middlewares, handler);
          break;

        default:
          throw Error(`${mehtodMetadata.method} method not valid`);
          break;
      }
    });

    // this.app.use(metadata.path, _router);
    this.router.use(metadata.path, _router);
  }

  private initRequestHandler(controller: any, metadata: HTTPMethodMetadata) {
    return async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      try {
        const _controller: any = Container.get(controller);
        const _method = _controller[metadata.propertyKey];

        let arrParamMetada: RequestParamMetadata[] =
          Reflect.getOwnMetadata(
            MetadataKeys.param,
            controller,
            metadata.propertyKey
          ) || [];

        let args: any[] = [];

        await Promise.all(
          arrParamMetada.map(async (paramMetadata) => {
            switch (paramMetadata.paramType) {
              case "body":
                try {
                  args[paramMetadata.index] = await transformAndValidate(
                    paramMetadata.type,
                    req.body,
                    {
                      transformer: paramMetadata.classTransform
                        ? paramMetadata.classTransform
                        : void 0,
                      validator: paramMetadata.validatorOptions,
                    }
                  );
                } catch (error) {
                  throw new ValidationError(error);
                }
                break;
              case "param":
                if (paramMetadata.name) {
                  args[paramMetadata.index] = req.params[paramMetadata.name];
                }
                break;
              case "query":
                if (paramMetadata.name) {
                  args[paramMetadata.index] = req.query[paramMetadata.name];
                }
                break;
            }
          })
        );

        metadata.arguments.map((arg, index) => {
          if (arg.name == "Context") {
            const ctx = new Context(req, res, next);
            args[index] = ctx;
          }
        });

        const result = await _method(...args);

        if (result && result.finished) {
          return result;
        }
        return res.send(result);
      } catch (error) {
        next(error);
        return;
      }
    };
  }

  private initErrorHandlers() {
    if (this.handleErrors) {
      this.app.use((req, res, next) => {
        const error: Error = new HTTPError("Not Found", 404);
        next(error);
      });

      this.app.use(
        (
          err: Error,
          req: express.Request,
          res: express.Response,
          next: express.NextFunction
        ) => {
          if (err instanceof ValidationError) {
            res.status(400);
            res.json({
              error: err,
            });
            return;
          } else if (err instanceof HTTPError) {
            res.status(err.statusCode);
            res.json(err);
            return;
          }

          res.status(500);
          res.json(err);
        }
      );
    }
  }
}

export function resty(options: Options): express.Application {
  const expressApplication = options.app ?? express();
  const restyApplication = new Application(
    expressApplication,
    options.router ?? express.Router(),
    options.controllers ?? [],
    options.middlewares,
    options.postMiddlewares,
    options.bodyParser,
    options.handleErrors ?? true,
    options.routePrefix
  );
  Container.set("resty:application", restyApplication);
  return expressApplication;
}