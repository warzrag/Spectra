import React, { useState } from 'react';

const TestInput: React.FC = () => {
  const [value, setValue] = useState('');

  return (
    <div className="p-4 bg-gray-800 rounded-lg m-4">
      <h3 className="text-white mb-2">Test Input</h3>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          console.log('Test input changed:', e.target.value);
          setValue(e.target.value);
        }}
        className="px-3 py-2 bg-gray-700 text-white rounded"
        placeholder="Type here to test"
      />
      <p className="text-white mt-2">Value: {value}</p>
    </div>
  );
};

export default TestInput;