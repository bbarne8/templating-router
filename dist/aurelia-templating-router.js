import * as LogManager from 'aurelia-logging';
import {customAttribute,bindable,ViewSlot,ViewLocator,customElement,noView,BehaviorInstruction,CompositionTransaction,CompositionEngine,ShadowDOM} from 'aurelia-templating';
import {inject,Container} from 'aurelia-dependency-injection';
import {Router,RouteLoader} from 'aurelia-router';
import {DOM} from 'aurelia-pal';
import {Origin} from 'aurelia-metadata';
import {relativeToFile} from 'aurelia-path';

const logger = LogManager.getLogger('route-href');

@customAttribute('route-href')
@bindable({name: 'route', changeHandler: 'processChange'})
@bindable({name: 'params', changeHandler: 'processChange'})
@bindable({name: 'attribute', defaultValue: 'href'})
@inject(Router, DOM.Element)
export class RouteHref {
  constructor(router, element) {
    this.router = router;
    this.element = element;
  }

  bind() {
    this.isActive = true;
    this.processChange();
  }

  unbind() {
    this.isActive = false;
  }

  attributeChanged(value, previous) {
    if (previous) {
      this.element.removeAttribute(previous);
    }

    this.processChange();
  }

  processChange() {
    return this.router.ensureConfigured()
      .then(() => {
        if (!this.isActive) {
          return;
        }

        let href = this.router.generate(this.route, this.params);
        this.element.setAttribute(this.attribute, href);
      })
      .catch(reason => {
        logger.error(reason);
      });
  }
}

class SwapStrategies {
  // animate the next view in before removing the current view;
  before(viewSlot, previousView, callback) {
    let promise = Promise.resolve(callback());

    if (previousView !== undefined) {
      return promise.then(() => viewSlot.remove(previousView, true));
    }

    return promise;
  }

  // animate the next view at the same time the current view is removed
  with(viewSlot, previousView, callback) {
    let promise = Promise.resolve(callback());

    if (previousView !== undefined) {
      return Promise.all([viewSlot.remove(previousView, true), promise]);
    }

    return promise;
  }

  // animate the next view in after the current view has been removed
  after(viewSlot, previousView, callback) {
    return Promise.resolve(viewSlot.removeAll(true)).then(callback);
  }
}

const swapStrategies = new SwapStrategies();

@customElement('router-view')
@noView
@inject(DOM.Element, Container, ViewSlot, Router, ViewLocator, CompositionTransaction, CompositionEngine)
export class RouterView {
  @bindable swapOrder;
  @bindable layoutView;
  @bindable layoutViewModel;
  @bindable layoutModel;

  constructor(element, container, viewSlot, router, viewLocator, compositionTransaction, compositionEngine) {
    this.element = element;
    this.container = container;
    this.viewSlot = viewSlot;
    this.router = router;
    this.viewLocator = viewLocator;
    this.compositionTransaction = compositionTransaction;
    this.compositionEngine = compositionEngine;
    this.router.registerViewPort(this, this.element.getAttribute('name'));

    if (!('initialComposition' in compositionTransaction)) {
      compositionTransaction.initialComposition = true;
      this.compositionTransactionNotifier = compositionTransaction.enlist();
    }
  }

  created(owningView) {
    this.owningView = owningView;
  }

  bind(bindingContext, overrideContext) {
    this.container.viewModel = bindingContext;
    this.overrideContext = overrideContext;
  }

  process(viewPortInstruction, waitToSwap) {
    let component = viewPortInstruction.component;
    let childContainer = component.childContainer;
    let viewModel = component.viewModel;
    let viewModelResource = component.viewModelResource;
    let metadata = viewModelResource.metadata;
    let config = component.router.currentInstruction.config;
    let viewPort = config.viewPorts ? config.viewPorts[viewPortInstruction.name] : {};

    // layoutInstruction is our layout viewModel
    let layoutInstruction = {
      viewModel: viewPort.layoutViewModel || config.layoutViewModel || this.layoutViewModel,
      view: viewPort.layoutView || config.layoutView || this.layoutView,
      model: viewPort.layoutModel || config.layoutModel || this.layoutModel,
      router: viewPortInstruction.component.router,
      childContainer: childContainer,
      viewSlot: this.viewSlot
    };

    return Promise.resolve(this.composeLayout(layoutInstruction))
    .then(layoutView => {
      let viewStrategy = this.viewLocator.getViewStrategy(component.view || viewModel);

      if (viewStrategy) {
        viewStrategy.makeRelativeTo(Origin.get(component.router.container.viewModel.constructor).moduleId);
      }

      return metadata.load(childContainer, viewModelResource.value, null, viewStrategy, true)
      .then(viewFactory => {
        if (!this.compositionTransactionNotifier) {
          this.compositionTransactionOwnershipToken = this.compositionTransaction.tryCapture();
        }

        viewPortInstruction.layout = layoutView ? layoutView.view || layoutView : undefined;

        viewPortInstruction.controller = metadata.create(childContainer,
          BehaviorInstruction.dynamic(
            this.element,
            viewModel,
            viewFactory
          )
        );

        if (waitToSwap) {
          return;
        }

        this.swap(viewPortInstruction);
      });
    });
  }

  composeLayout(instruction) {
    if (instruction.viewModel || instruction.view) {
      return this.compositionEngine.compose(instruction);
    }

    return undefined;
  }

  swap(viewPortInstruction) {
    let work = () => {
      let previousView = this.view;
      let swapStrategy;
      let layout = viewPortInstruction.layout;
      let viewSlot = layout ? new ViewSlot(layout.firstChild, false) : this.viewSlot;

      if (layout) {
        viewSlot.attached();
      }

      swapStrategy = this.swapOrder in swapStrategies
                  ? swapStrategies[this.swapOrder]
                  : swapStrategies.after;

      swapStrategy(viewSlot, previousView, () => {
        if (layout) {
          ShadowDOM.distributeView(viewPortInstruction.controller.view, layout.slots, viewSlot);
          this._notify();
        } else {
          return Promise.resolve(viewSlot.add(viewPortInstruction.controller.view)).then(() => { this._notify(); });
        }

        this.view = viewPortInstruction.controller.view;
        return Promise.resolve();
      });
    };

    viewPortInstruction.controller.automate(this.overrideContext, this.owningView);

    if (this.compositionTransactionOwnershipToken) {
      return this.compositionTransactionOwnershipToken.waitForCompositionComplete().then(() => {
        this.compositionTransactionOwnershipToken = null;
        return work();
      });
    }

    return work();
  }

  _notify() {
    if (this.compositionTransactionNotifier) {
      this.compositionTransactionNotifier.done();
      this.compositionTransactionNotifier = null;
    }
  }
}

@inject(CompositionEngine)
export class TemplatingRouteLoader extends RouteLoader {
  constructor(compositionEngine) {
    super();
    this.compositionEngine = compositionEngine;
  }

  loadRoute(router, config) {
    let childContainer = router.container.createChild();
    let instruction = {
      viewModel: relativeToFile(config.moduleId, Origin.get(router.container.viewModel.constructor).moduleId),
      childContainer: childContainer,
      view: config.view || config.viewStrategy,
      router: router
    };

    childContainer.getChildRouter = function() {
      let childRouter;

      childContainer.registerHandler(Router, c => {
        return childRouter || (childRouter = router.createChild(childContainer));
      });

      return childContainer.get(Router);
    };

    return this.compositionEngine.ensureViewModel(instruction);
  }
}
