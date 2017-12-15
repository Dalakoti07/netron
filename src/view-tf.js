/*jshint esversion: 6 */

// Experimental

var tensorflow = protobuf.roots.tf.tensorflow;

class TensorFlowModel {

    constructor(hostService) {
    }

    openBuffer(buffer, identifier) { 
        try {
            if (identifier == 'saved_model.pb') {
                this._model = tensorflow.SavedModel.decode(buffer);
                this._graphs = [];
                for (var i = 0; i < this._model.metaGraphs.length; i++) {
                    this._graphs.push(new TensorFlowGraph(this, this._model.metaGraphs[i], i));
                }
                this._format = 'TensorFlow Saved Model';
                if (this._model.savedModelSchemaVersion) {
                    this._format += ' v' + this._model.savedModelSchemaVersion.toString();
                }
            }
            else {
                var graphDef = tensorflow.GraphDef.decode(buffer);
                var metaGraph = new tensorflow.MetaGraphDef();
                metaGraph.graphDef = graphDef;
                metaGraph.anyInfo = identifier;
                this._model = new tensorflow.SavedModel();
                this._model.metaGraphs.push(metaGraph);
                this._graphs = [ new TensorFlowGraph(this._model, metaGraph) ];
                this._format = 'TensorFlow Graph Defintion';
            }

            this._activeGraph = (this._graphs.length > 0) ? this._graphs[0] : null;

            if (!TensorFlowModel.operatorMetadata) {
                TensorFlowModel.operatorMetadata = new TensorFlowOperatorMetadata(hostService);
            }
        }
        catch (err) {
            return err;
        }
        return null;
    }

    format() {
        var summary = { properties: [], graphs: [] };
        summary.properties.push({ name: 'Format', value: this._format });

        this.graphs.forEach((graph) => {
            summary.graphs.push({
                name: graph.name,
                version: graph.version,
                tags: graph.tags,
                inputs: graph.inputs,
                outputs: graph.outputs
            });
            // metaInfoDef.tensorflowGitVersion
            // TODO signature
        });
    
        return summary;
    }

    get graphs() {
        return this._graphs;    
    }

    get activeGraph() {
        return this._activeGraph;
    }

    updateActiveGraph(name) {
        this.graphs.forEach((graph) => {
            if (name == graph.name) {
                this._activeGraph = graph;
                return;
            }            
        });
    }
}

class TensorFlowGraph {

    constructor(model, graph, index) {
        this._model = model;
        this._graph = graph;
        this._name = this._graph.anyInfo ? this._graph.anyInfo.toString() : ('(' + index.toString() + ')');

        this._nodeMap = {};
        var nodes = this._graph.graphDef.node;
        nodes.forEach((node) => {
            this._nodeMap[node.name] = node;   
            node.output = [];         
        });
        nodes.forEach((node) => {
            for (var i = 0; i < node.input.length; i++)
            {
                var split = node.input[i].split(':', 1);
                if (split.length == 1) {
                    split.push('0');
                }
                // TODO
                if (split[0].startsWith('^')) {
                    split[0] = split[0].substring(1);
                }
                var outputName = split[0];
                var outputIndex = parseInt(split[1]);
                var outputNode = this._nodeMap[outputName];
                node.input[i] = outputName + ':' + outputIndex.toString();
                if (outputNode) {
                    for (var j = outputNode.output.length; j <= outputIndex; j++) {
                        outputNode.output.push('');
                    }
                    outputNode.output[outputIndex] = node.input[i];
                }
            }
        });
        this._outputMap = {};
        nodes.forEach((node) => {
            node.output.forEach((output) => {
                var count = this._outputMap[output];
                if (!count) {
                    count = 0;
                }
                this._outputMap[output] = count + 1;
            });
        });

        this._initializerMap = {};
        this._graph.graphDef.node.forEach((node) => {
            if (this.checkNode(node, 'Const', 0, 1)) {
                var attributeValue = null;
                Object.keys(node.attr).forEach((name) => {
                    if (name == 'value') {
                        attributeValue = node.attr[name];
                        return;
                    }
                });
                if (attributeValue && attributeValue.hasOwnProperty('tensor')) {
                    this._initializerMap[node.output[0]] = new TensorFlowTensor(attributeValue.tensor, node.output[0], node.name, 'Constant');
                }
            }
        });
        this._graph.graphDef.node.forEach((node) => {
            if (this.checkNode(node, 'Identity', 1, 1)) {
                var tensor = this._initializerMap[node.input[0]];
                if (tensor) {
                    this._initializerMap[node.input[0]] = "-";
                    tensor._id = node.output[0]; // TODO update tensor id
                    tensor._title = 'Constant Identity';
                    this._initializerMap[node.output[0]] = tensor;
                }
            }
        });
    }

    get model() {
        return this._model;
    }

    get name() {
        return this._name;
    }

    get version() {
        if (this._graph.metaInfoDef && this._graph.metaInfoDef.tensorflowVersion) {
            return 'TensorFlow ' + this._graph.metaInfoDef.tensorflowVersion;
        }
        return null;
    }

    get tags() {
        if (this._graph.metaInfoDef && this._graph.metaInfoDef.tags) {
            return this._graph.metaInfoDef.tags.join(', ');
        }
        return null;
    }

    get inputs() {
        return [];
    }

    get outputs() {
        return [];
    }

    get initializers() {
        var results = [];
        Object.keys(this._initializerMap).forEach((key) => {
            var value = this._initializerMap[key];
            if (value != '-') {
                results.push(value);
            }
        });
        return results;
    }

    get nodes() {
        // graph.graphDef.node.forEach(function (node) {
        //     console.log(node.name + ' [' + (!node.input ? "" : node.input.map(s => s).join(',')) + ']');
        // });
        var results = [];
        this._graph.graphDef.node.forEach((node) => {
            if (!this._initializerMap[node.name + ':0']) {
                results.push(new TensorFlowNode(this, node));
            }
        });
        return results;
    }

    get metadata() {
        if (!this._metadata) {
            this._metadata = new TensorFlowGraphOperatorMetadata(this._graph.metaInfoDef);
        }
        return this._metadata;
    }

    checkNode(node, operator, inputs, outputs) {
        if (node.op != operator) {
            return false;
        }
        if (outputs == 0 && node.output.length != 0) {
            return false;
        }
        if (inputs == 0 && node.input.length != 0) {
            return false;
        }
        if (outputs > 0 && node.output.length != 1 && this._outputMap[node.output[0] != outputs]) {
            return false;
        }
        if (inputs > 0 && node.input.length != 1 && this._outputMap[node.input[0] != inputs]) {
            return false;
        }
        return true;
    }

}

class TensorFlowNode {

    constructor(graph, node) {
        this._graph = graph;
        this._node = node;
    }

    get operator() {
        return this._node.op;
    }

    get name() {
        return this._node.name;
    }

    get description() {
        return null;
    }

    get primitive() {
        /*
        switch (this._node.op) {
            case 'Add': return '+';
            case 'Mul': return '*';
            case 'Sub': return '-';
            case 'Identity': return 'I';
        }
        */
        return null;
    }

    get constant() {
        return this._node.op == 'Const';
    }

    get documentation() {
        var graphMetadata = this._graph.metadata;
        if (graphMetadata) {
            return graphMetadata.getOperatorDocumentation(this.operator);       
        }
        return null;
    }

    get domain() {
        return null;
    }

    get inputs() {
        var graphMetadata = this._graph.metadata;
        var node = this._node;
        var results = [];
        if (node.input) {
            node.input.forEach((input, index) => {
                results.push({
                    'id': input, 
                    'name': graphMetadata ? graphMetadata.getInputName(node.op, index) : ('(' + index.toString() + ')'),
                    'type': ''
                });
            });
        }
        return results;
    }

    get outputs() {
        var graphMetadata = this._graph.metadata;
        var node = this._node;
        var results = [];
        if (node.output) {
            node.output.forEach((output, index) => {
                results.push({
                    'id': output, 
                    'name': graphMetadata ? graphMetadata.getOutputName(node.op, index) : ('(' + index.toString() + ')'),
                    'type': ''
                });
            });
        }
        return results;
    }

    get attributes() {
        var node = this._node;
        var result = [];
        if (node.attr) {
            Object.keys(node.attr).forEach((name) => {
                if (name != '_output_shapes' && name != 'T') {
                    var value = node.attr[name];
                    result.push(new TensorFlowAttribute(name, value));
                }
            });
        }
        return result;
    }
}

class TensorFlowAttribute { 
    constructor(name, value) {
        this._name = name;
        this._value = value;
    }

    get name() {
        return this._name;
    }

    get type() {
        return '';
    }

    get value() {
        if (this._value.hasOwnProperty('type')) {
            return TensorFlowTensor.formatDataType(this._value.type);
        }
        else if (this._value.hasOwnProperty('i')) {
            return this._value.i.toString();
        }
        else if (this._value.hasOwnProperty('f')) {
            return this._value.f.toString();
        }
        else if (this._value.hasOwnProperty('b')) {
            return this._value.b.toString();
        }
        else if (this._value.hasOwnProperty('shape')) {
            return TensorFlowTensor.formatTensorShape(this._value.shape);;
        }
        else if (this._value.hasOwnProperty('s')) {
            if (this._value.s.filter(c => c <= 32 && c >= 128).length == 0) {
                return '"' + String.fromCharCode.apply(null, this._value.s) + '"';
            }
            return this._value.s.map(v => v.toString()).join(', ');           
        }
        else if (this._value.hasOwnProperty('list')) {
            var list = this._value.list;
            if (list.s && list.s.length > 0) {
                if (list.s.length > 65536) {
                    return "Too large to render.";
                }
                return list.s.map((s) => {
                    if (s.filter(c => c <= 32 && c >= 128).length == 0) {
                        return '"' + String.fromCharCode.apply(null, s) + '"';
                    }
                    return s.map(v => v.toString()).join(', ');    
                }).join(', ');
            }
            else if (list.i && list.i.length > 0) {
                if (list.i.length > 65536) {
                    return "Too large to render.";
                }
                return list.i.map((v) => v.toString()).join(', ');
            }
            else if (list.f && list.f.length > 0) {
                if (list.f.length > 65536) {
                    return "Too large to render.";
                }
                return list.f.map((v) => v.toString()).join(', ');
            }
            else if (list.type && list.type.length > 0) {
                if (list.type.length > 65536) {
                    return "Too large to render.";
                }
                return list.type.map((type) => TensorFlowTensor.formatDataType(type)).join(', ');
            }
        }
        debugger;
        return '?';        
    }

    get tensor() {
        return this._value.hasOwnProperty('tensor');
    }
}

class TensorFlowTensor {

    constructor(tensor, id, name, title) {
        this._tensor = tensor;
        this._id = id;
        this._name = name;
        if (title) {
            this._title = title;
        }
    }

    get id() {
        return this._id;
    }

    get name() {
        return this._name;
    }

    get type() {
        return TensorFlowTensor.formatTensorType(this._tensor);
    }

    get title() {
        return this._title;
    }

    get value() {
        return '?';        
    }

    static formatTensorType(tensor) {
        if (tensor.dtype) {
            var type = TensorFlowTensor.formatDataType(tensor.dtype);
            if (tensor.tensorShape) {
                type += TensorFlowTensor.formatTensorShape(tensor.tensorShape);
            }
            return type;
        }
        debugger;
        return '?';
    }

    static formatDataType(type) {
        if (!TensorFlowTensor.dataType)
        {
            TensorFlowTensor.dataType = {};
            Object.keys(tensorflow.DataType).forEach((key) => {
                var value = tensorflow.DataType[key];
                key = key.startsWith('DT_') ? key.substring(3) : key;
                TensorFlowTensor.dataType[value] = key.toLowerCase();
            });
        }
        var text = TensorFlowTensor.dataType[type];
        if (text) { 
            return text;
        }
        debugger;
        return '?';
    }

    static formatTensorShape(shape) {
        if (shape.dim) {
            return '[' + shape.dim.map((dim) => dim.size ? dim.size.toString() : '?').join(',') + ']';
        }
        debugger;
        return '?';
    }
}

class TensorFlowOperatorMetadata {

    constructor(hostService) {
        this._map = {};
        hostService.request('/tf-operator.json', (err, data) => {
            if (err != null) {
                // TODO error
            }
            else {
                var items = JSON.parse(data);
                if (items) {
                    items.forEach((item) => {
                        if (item.name && item.schema)
                        {
                            var name = item.name;
                            var schema = item.schema;
                            this._map[name] = schema;
                        }
                    });
                }
            }
        });
    }

    getSchema(operator) {
        return this._map[operator];
    }
}

class TensorFlowGraphOperatorMetadata {

    constructor(metaInfoDef) {
        this._map = {};
        if (metaInfoDef && metaInfoDef.strippedOpList && metaInfoDef.strippedOpList.op) {
            metaInfoDef.strippedOpList.op.forEach((opDef) => {
                var schema = { inputs: [], outputs: [], attributes: [] };
                opDef.inputArg.forEach(function (inputArg) {
                    schema.inputs.push({ name: inputArg.name, typeStr: inputArg.typeAttr });
                });
                opDef.outputArg.forEach(function (outputArg) {
                    schema.outputs.push({ name: outputArg.name, typeStr: outputArg.typeAttr });
                });
                opDef.attr.forEach(function (attr) {
                    schema.attributes.push({ name: attr.name, type: attr.type });
                });
                this._map[opDef.name] = schema;
            });
        }
    }

    getSchema(operator) {
        var schema = TensorFlowModel.operatorMetadata.getSchema(operator);
        if (!schema) {
            schema = this._map[operator];
        }
        return schema;
    }

    getInputName(operator, index) {
        var schema = this.getSchema(operator);
        if (schema) {
            var inputs = schema.inputs;
            if (inputs && index < inputs.length) {
                var input = inputs[index];
                if (input) {
                    var name = input.name;
                    if (name) {
                        return name;
                    }
                }
            }
        }
        return '(' + index.toString() + ')';
    }

    getOutputName(operator, index) {
        var schema = this.getSchema(operator);
        if (schema) {
            var outputs = schema.outputs;
            if (outputs && index < outputs.length) {
                var output = outputs[index];
                if (output) {
                    var name = output.name;
                    if (name) {
                        return name;
                    }
                }
            }
        }
        return '(' + index.toString() + ')';
    }

    getOperatorDocumentation(operator) {
        var schema = this.getSchema(operator);
        if (schema) {
            schema = Object.assign({}, schema);
            schema.name = operator;
            schema.summary = marked(schema.summary);
            schema.description = marked(schema.description);
            if (schema.inputs) {
                schema.inputs.forEach((input) => {
                    input.description = marked(input.description);
                });
            }
            if (schema.outputs) {
                schema.outputs.forEach((output) => {
                    output.description = marked(output.description);
                });
            }
            if (schema.attributes) {
                schema.attributes.forEach((attribute) => {
                    attribute.description = marked(attribute.description);
                });
            }
            var template = Handlebars.compile(operatorTemplate, 'utf-8');
            return template(schema);
        }
        return null;
    }
}